import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_TIMEOUT_MS } from '../src/lb/ai'
import { REPORT_THRESHOLD, SUBMIT_PER_MIN } from '../src/lb/api'
import { cleanupLeaderboard, LB_RETENTION_DAYS, recheckUnchecked } from '../src/lb/maintain'
import { fallbackName } from '../src/lb/moderation'
import { DAY_MS } from '../src/util'
import type { AppEnv } from '../src/env'
import { call, fakeAi, resetDb, testEnv } from './helpers'

let ipSeq = 0
interface LbOpts {
  origin?: string | null
  ip?: string
}

function lbPost(path: string, body: unknown, o: LbOpts = {}) {
  const headers = new Headers({ 'Content-Type': 'text/plain' })
  if (o.origin !== null) headers.set('Origin', o.origin ?? 'https://devcol.net')
  // 기본은 요청마다 다른 IP (rate limit에 걸리지 않게). rate limit 테스트는 ip를 고정한다.
  headers.set('CF-Connecting-IP', o.ip ?? `198.51.100.${++ipSeq % 250}`)
  return new Request(`https://a.devcol.net${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

const sub = (over: Record<string, unknown> = {}) => ({ game: 'stack-up', name: 'Kim', score: 100, stats: { stage: 3 }, durationMs: 30_000, ...over })

async function submit(body: Record<string, unknown>, e: AppEnv = testEnv(), o: LbOpts = {}) {
  const res = await call(lbPost('/lb/submit', body, o), e)
  return { status: res.status, res, data: (await res.json()) as Record<string, unknown> }
}

async function top(game = 'stack-up', n?: number) {
  const res = await call(new Request(`https://a.devcol.net/lb/top?game=${game}${n ? `&n=${n}` : ''}`, { headers: { Origin: 'https://devcol.net' } }))
  return { res, data: (await res.json()) as { entries: Record<string, unknown>[] } }
}

const entry = (id: unknown) => env.DB.prepare('SELECT * FROM lb_entries WHERE id = ?').bind(id).first<Record<string, unknown>>()

let fetchSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  await resetDb()
  // 게임 slug 확인 fetch: stack-up / bug-squash / new-game만 사이트에 있다고 친다
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const ok = /^https:\/\/devcol\.net\/games\/(stack-up|bug-squash|new-game)\/$/.test(url)
    return new Response(ok ? '<html></html>' : 'not found', { status: ok ? 200 : 404 })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /lb/submit — owner token', () => {
  it('first submit creates an owner and returns a token once; only its hash is stored', async () => {
    const { status, data } = await submit(sub())
    expect(status).toBe(200)
    expect(data).toMatchObject({ publishedName: 'Kim', nameStatus: 'ok', best: 100, rank: 1 })
    expect(data.token).toMatch(/^[0-9a-f]{64}$/)
    const owners = (await env.DB.prepare('SELECT * FROM lb_owners').all()).results
    expect(owners).toHaveLength(1)
    expect(JSON.stringify(owners)).not.toContain(data.token as string)
  })

  it('submits with the token reuse the owner: one row per game, best score kept', async () => {
    const first = await submit(sub({ score: 100 }))
    const token = first.data.token
    const lower = await submit(sub({ score: 50, token }))
    expect(lower.data).toMatchObject({ entryId: first.data.entryId, best: 100 })
    expect(lower.data.token).toBeUndefined()
    const higher = await submit(sub({ score: 200, name: 'Kim Lee', token }))
    expect(higher.data).toMatchObject({ entryId: first.data.entryId, best: 200, publishedName: 'Kim Lee' })
    await submit(sub({ game: 'bug-squash', score: 7, token }))
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_owners').first<{ n: number }>())!.n).toBe(1)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_entries').first<{ n: number }>())!.n).toBe(2)
  })

  it('an unknown token gets a fresh owner and a new token', async () => {
    const { data } = await submit(sub({ token: 'a'.repeat(64) }))
    expect(data.token).toMatch(/^[0-9a-f]{64}$/)
    expect(data.token).not.toBe('a'.repeat(64))
  })

  it('stores no raw IP and no rejected nickname', async () => {
    await submit(sub({ name: 'fuck you' }), testEnv(), { ip: '203.0.113.99' })
    const dump = JSON.stringify(
      await Promise.all(['lb_owners', 'lb_entries', 'lb_rate', 'lb_names'].map(async (t) => (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results)),
    )
    expect(dump).not.toContain('203.0.113.99')
    expect(dump.toLowerCase()).not.toContain('fuck')
  })
})

describe('POST /lb/submit — validation, origin, bounds', () => {
  it.each([
    ['no game', { game: undefined }],
    ['bad slug', { game: '../etc' }],
    ['negative score', { score: -1 }],
    ['string score', { score: '100' }],
    ['NaN-ish duration', { durationMs: null }],
    ['stats array', { stats: [1] }],
    ['stat not a number', { stats: { stage: 'x' } }],
    ['bad token shape', { token: 'xyz' }],
  ])('%s → 400', async (_, over) => {
    expect((await submit(sub(over))).status).toBe(400)
  })

  it('oversized body → 400', async () => {
    expect((await submit(sub({ name: 'x'.repeat(3000) }))).status).toBe(400)
  })

  it('foreign or missing Origin → 403; allowed Origin gets CORS headers', async () => {
    expect((await submit(sub(), testEnv(), { origin: 'https://evil.example' })).status).toBe(403)
    expect((await submit(sub(), testEnv(), { origin: null })).status).toBe(403)
    const ok = await submit(sub(), testEnv(), { origin: 'https://www.devcol.net' })
    expect(ok.res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.devcol.net')
    expect(ok.res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('preflight answers only for allowed origins', async () => {
    const pre = (origin: string) => call(new Request('https://a.devcol.net/lb/submit', { method: 'OPTIONS', headers: { Origin: origin } }))
    expect((await pre('https://devcol.net')).headers.get('Access-Control-Allow-Origin')).toBe('https://devcol.net')
    expect((await pre('https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('unknown slug is registered only when the site has /games/<slug>/', async () => {
    expect((await submit(sub({ game: 'new-game' }))).status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith('https://devcol.net/games/new-game/', expect.anything())
    expect(await env.DB.prepare("SELECT slug FROM lb_games WHERE slug = 'new-game'").first()).not.toBeNull()

    const missing = await submit(sub({ game: 'no-such-game' }))
    expect(missing).toMatchObject({ status: 404, data: { error: 'unknown_game' } })
    expect(await env.DB.prepare("SELECT slug FROM lb_games WHERE slug = 'no-such-game'").first()).toBeNull()

    // 한 번 등록되면 다시 확인하지 않는다
    fetchSpy.mockClear()
    await submit(sub({ game: 'new-game' }))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('site fetch failing → unknown_game, nothing registered', async () => {
    fetchSpy.mockRejectedValue(new Error('network'))
    expect((await submit(sub())).status).toBe(404)
  })

  it('per-game bounds from lb_games reject impossible runs', async () => {
    await env.DB.prepare(
      "INSERT INTO lb_games (slug, max_score, max_score_per_sec, min_duration_ms, stat_max, enabled, created_at) VALUES ('stack-up', 1000, 10, 5000, '{\"stage\":20}', 1, 0)",
    ).run()
    expect((await submit(sub({ score: 1001, durationMs: 600_000 }))).data).toEqual({ error: 'out_of_bounds' })
    expect((await submit(sub({ durationMs: 4000 }))).status).toBe(422)
    expect((await submit(sub({ score: 500, durationMs: 10_000 }))).status).toBe(422) // 50/s > 10/s
    expect((await submit(sub({ stats: { stage: 21 } }))).status).toBe(422)
    expect((await submit(sub({ score: 90, durationMs: 10_000, stats: { stage: 20, other: 999 } }))).status).toBe(200)
  })

  it('disabled game → 403', async () => {
    await env.DB.prepare("INSERT INTO lb_games (slug, max_score, max_score_per_sec, min_duration_ms, enabled, created_at) VALUES ('stack-up', 1e7, 0, 0, 0, 0)").run()
    expect((await submit(sub())).data).toEqual({ error: 'game_disabled' })
  })

  it(`more than ${SUBMIT_PER_MIN} submits per minute from one client → 429`, async () => {
    const first = await submit(sub(), testEnv(), { ip: '203.0.113.5' })
    const token = first.data.token
    for (let i = 1; i < SUBMIT_PER_MIN; i++) expect((await submit(sub({ token }), testEnv(), { ip: '203.0.113.5' })).status).toBe(200)
    expect((await submit(sub({ token }), testEnv(), { ip: '203.0.113.5' })).status).toBe(429)
    expect((await submit(sub({ token }), testEnv(), { ip: '203.0.113.6' })).status).toBe(200)
  })

  it('more than 3 new owners per hour from one client → 429', async () => {
    for (let i = 0; i < 3; i++) expect((await submit(sub(), testEnv(), { ip: '203.0.113.8' })).status).toBe(200)
    expect((await submit(sub(), testEnv(), { ip: '203.0.113.8' })).data).toEqual({ error: 'rate_limited' })
  })
})

describe('nickname moderation on submit', () => {
  it.each(['씨발', '시1발', 'ㅅㅂ', 'f u c k', 'fuuuck', '5h1t', '운영자', 'www.x.com', 'hi😺'])('%s → Player#### (rules), AI not called', async (name) => {
    const ai = fakeAi()
    const { data } = await submit(sub({ name }), testEnv({ AI: ai }))
    expect(data.nameStatus).toBe('rules_fallback')
    expect(data.publishedName).toMatch(/^Player\d{4}$/)
    expect(ai.calls).toEqual([])
  })

  it.each(['class', 'Assassin', '김철수', '시발점'])('%s → published as typed', async (name) => {
    const { data } = await submit(sub({ name }))
    expect(data).toMatchObject({ publishedName: name, nameStatus: 'ok' })
  })

  it('AI says UNSAFE → Player####, verdict cached so the next owner does not call AI again', async () => {
    const ai = fakeAi((n) => (n === 'gaesaeki' ? 'SAFE' : n.includes('badword') ? 'UNSAFE' : 'SAFE'))
    const e = testEnv({ AI: ai })
    const a = await submit(sub({ name: 'badword99' }), e)
    expect(a.data).toMatchObject({ nameStatus: 'ai_fallback' })
    expect(a.data.publishedName).toMatch(/^Player\d{4}$/)
    const b = await submit(sub({ name: 'BADWORD99' }), e)
    expect(b.data.nameStatus).toBe('ai_fallback')
    expect(ai.calls).toEqual(['badword99'])
  })

  it('daily AI cap reached → AI not called, name published as unchecked_ai', async () => {
    const ai = fakeAi()
    const e = testEnv({ AI: ai, AI_DAILY_CAP: '2' })
    await submit(sub({ name: 'Alpha' }), e)
    await submit(sub({ name: 'Bravo' }), e)
    const third = await submit(sub({ name: 'Charlie' }), e)
    expect(ai.calls).toEqual(['Alpha', 'Bravo'])
    expect(third.data).toMatchObject({ publishedName: 'Charlie', nameStatus: 'unchecked_ai' })
    const day = new Date().toISOString().slice(0, 10)
    expect(await env.DB.prepare('SELECT calls FROM lb_ai_usage WHERE day = ?').bind(day).first()).toEqual({ calls: 2 })
  })

  it('cap 0 or AI_MODERATION=off → never calls AI', async () => {
    const ai = fakeAi()
    expect((await submit(sub({ name: 'Delta' }), testEnv({ AI: ai, AI_DAILY_CAP: '0' }))).data.nameStatus).toBe('unchecked_ai')
    expect((await submit(sub({ name: 'Echo' }), testEnv({ AI: ai, AI_MODERATION: 'off' }))).data.nameStatus).toBe('unchecked_ai')
    expect((await submit(sub({ name: 'Foxtrot' }), testEnv({ AI: undefined }))).data.nameStatus).toBe('unchecked_ai')
    expect(ai.calls).toEqual([])
  })

  it('AI throws or gives a junk answer → rules-only verdict, nothing cached', async () => {
    const thrower = fakeAi(() => {
      throw new Error('quota exceeded')
    })
    expect((await submit(sub({ name: 'Golf' }), testEnv({ AI: thrower }))).data).toMatchObject({ publishedName: 'Golf', nameStatus: 'unchecked_ai' })
    expect((await submit(sub({ name: 'Hotel' }), testEnv({ AI: fakeAi(() => 'I cannot help') }))).data.nameStatus).toBe('unchecked_ai')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_names').first<{ n: number }>())!.n).toBe(0)
  })

  it(
    'AI timeout → rules-only verdict',
    async () => {
      const hang = fakeAi(() => new Promise<string>(() => {}))
      const t0 = Date.now()
      const { data } = await submit(sub({ name: 'India' }), testEnv({ AI: hang }))
      expect(data.nameStatus).toBe('unchecked_ai')
      expect(Date.now() - t0).toBeGreaterThanOrEqual(AI_TIMEOUT_MS - 100)
    },
    AI_TIMEOUT_MS + 5000,
  )

  it('cron re-checks unchecked names once AI is available again', async () => {
    const down = testEnv({ AI_DAILY_CAP: '0' })
    const bad = await submit(sub({ name: 'Juliet' }), down)
    const good = await submit(sub({ name: 'Kilo' }), down)
    const ai = fakeAi((n) => (n === 'Juliet' ? 'UNSAFE' : 'SAFE'))
    expect(await recheckUnchecked(testEnv({ AI: ai }), Date.now())).toBe(2)
    const badRow = await entry(bad.data.entryId)
    expect(badRow).toMatchObject({ name_status: 'ai_fallback', name: await fallbackName(badRow!.owner_id as string) })
    expect(await entry(good.data.entryId)).toMatchObject({ name: 'Kilo', name_status: 'ok' })
  })

  it('cron re-check stops when the cap is hit again', async () => {
    await submit(sub({ name: 'Lima' }), testEnv({ AI_DAILY_CAP: '0' }))
    expect(await recheckUnchecked(testEnv({ AI_DAILY_CAP: '0' }), Date.now())).toBe(0)
  })
})

describe('GET /lb/top', () => {
  it('orders by score, hides hidden rows, caps n and leaks no owner ids', async () => {
    const a = await submit(sub({ name: 'Alpha', score: 10 }))
    await submit(sub({ name: 'Bravo', score: 30 }))
    await submit(sub({ name: 'Charlie', score: 20 }))
    await env.DB.prepare('UPDATE lb_entries SET hidden = 1 WHERE id = ?').bind(a.data.entryId).run()
    const { res, data } = await top()
    expect(data.entries.map((e) => e.name)).toEqual(['Bravo', 'Charlie'])
    expect(data.entries[0]).toEqual({ id: expect.any(Number), name: 'Bravo', score: 30, stats: { stage: 3 }, ts: expect.any(Number) })
    expect(JSON.stringify(data)).not.toContain('owner')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://devcol.net')
    expect((await top('stack-up', 1)).data.entries).toHaveLength(1)
    expect((await call(new Request('https://a.devcol.net/lb/top?game=../x'))).status).toBe(400)
  })

  it('rank in the submit reply counts only visible higher scores', async () => {
    await submit(sub({ score: 300 }))
    expect((await submit(sub({ score: 200 }))).data.rank).toBe(2)
  })
})

describe('POST /lb/delete — token checked', () => {
  it('unknown token → 404 and nothing deleted; bad shape → 400', async () => {
    await submit(sub())
    expect((await call(lbPost('/lb/delete', { token: 'b'.repeat(64) }))).status).toBe(404)
    expect((await call(lbPost('/lb/delete', { token: 'nope' }))).status).toBe(400)
    expect((await call(lbPost('/lb/delete', { token: 'b'.repeat(64) }, { origin: 'https://evil.example' }))).status).toBe(403)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_entries').first<{ n: number }>())!.n).toBe(1)
  })

  it('one game: removes that entry only, the token keeps working', async () => {
    const first = await submit(sub())
    const token = first.data.token
    await submit(sub({ game: 'bug-squash', token }))
    const other = await submit(sub({ name: 'Other' }))
    const res = await call(lbPost('/lb/delete', { token, game: 'stack-up' }))
    expect(await res.json()).toEqual({ deleted: 1 })
    expect(await entry(first.data.entryId)).toBeNull()
    expect(await entry(other.data.entryId)).not.toBeNull()
    expect((await submit(sub({ game: 'bug-squash', token }))).data.token).toBeUndefined()
  })

  it('all games: removes every entry, its reports and the owner; the old token is dead', async () => {
    const first = await submit(sub())
    const token = first.data.token
    await submit(sub({ game: 'bug-squash', token }))
    await call(lbPost('/lb/report', { entryId: first.data.entryId }))
    expect(await (await call(lbPost('/lb/delete', { token }))).json()).toEqual({ deleted: 2 })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_owners').first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_reports').first<{ n: number }>())!.n).toBe(0)
    expect((await call(lbPost('/lb/delete', { token }))).status).toBe(404)
    expect((await submit(sub({ token }))).data.token).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('POST /lb/report', () => {
  it(`${REPORT_THRESHOLD} distinct reporters → auto-renamed to Player#### and locked`, async () => {
    const target = await submit(sub({ name: 'Mike' }))
    const id = target.data.entryId
    for (let i = 0; i < REPORT_THRESHOLD - 1; i++) await call(lbPost('/lb/report', { entryId: id }, { ip: `203.0.113.${50 + i}` }))
    // 같은 사람이 여러 번 신고해도 한 번
    await call(lbPost('/lb/report', { entryId: id }, { ip: '203.0.113.50' }))
    expect(await entry(id)).toMatchObject({ name: 'Mike', name_status: 'ok' })
    const res = await call(lbPost('/lb/report', { entryId: id }, { ip: '203.0.113.99' }))
    expect(await res.json()).toEqual({ ok: true })
    const row = await entry(id)
    expect(row).toMatchObject({ name_status: 'reported', name_locked: 1, name: await fallbackName(row!.owner_id as string) })
    // 잠긴 이름은 다음 제출의 닉네임으로 바뀌지 않는다
    const again = await submit(sub({ name: 'Mike2', score: 999, token: target.data.token }))
    expect(again.data.publishedName).toBe(row!.name)
  })

  it('unknown entry → 404, bad id → 400, too many reports → 429', async () => {
    expect((await call(lbPost('/lb/report', { entryId: 12345 }))).status).toBe(404)
    expect((await call(lbPost('/lb/report', { entryId: 'x' }))).status).toBe(400)
    const { data } = await submit(sub())
    for (let i = 0; i < 5; i++) await call(lbPost('/lb/report', { entryId: data.entryId }, { ip: '203.0.113.77' }))
    expect((await call(lbPost('/lb/report', { entryId: data.entryId }, { ip: '203.0.113.77' }))).status).toBe(429)
  })
})

describe('leaderboard retention (cron)', () => {
  it(`entries untouched for ${LB_RETENTION_DAYS} days are deleted with their owner`, async () => {
    const old = await submit(sub({ name: 'Old' }))
    const fresh = await submit(sub({ name: 'Fresh' }))
    const past = Date.now() - (LB_RETENTION_DAYS + 1) * DAY_MS
    await env.DB.batch([
      env.DB.prepare('UPDATE lb_entries SET updated_at = ? WHERE id = ?').bind(past, old.data.entryId),
      env.DB.prepare('UPDATE lb_owners SET last_seen = ? WHERE id = (SELECT owner_id FROM lb_entries WHERE id = ?)').bind(past, old.data.entryId),
    ])
    await cleanupLeaderboard(env.DB, Date.now())
    expect(await entry(old.data.entryId)).toBeNull()
    expect(await entry(fresh.data.entryId)).not.toBeNull()
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_owners').first<{ n: number }>())!.n).toBe(1)
  })
})
