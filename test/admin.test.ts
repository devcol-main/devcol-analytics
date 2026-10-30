import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { __setJwksForTest, histogram } from '../src/admin'
import { kstDay } from '../src/util'
import { call, pv, resetDb, send, testEnv } from './helpers'

const TEAM = 'test.cloudflareaccess.com'
const AUD = 'test-aud'
let key: CryptoKeyPair
let otherKey: CryptoKeyPair

const b64url = (data: Uint8Array | string) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function sign(payload: Record<string, unknown>, k: CryptoKey = key.privateKey, kid = 'k1') {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`
}

const claims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  exp: Math.floor(Date.now() / 1000) + 600,
  ...over,
})

function adminReq(path: string, token?: string, method = 'GET') {
  const headers = new Headers()
  if (token) headers.set('Cf-Access-Jwt-Assertion', token)
  return new Request(`https://a.devcol.net${path}`, { method, headers })
}

beforeAll(async () => {
  const gen = () =>
    crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as Promise<CryptoKeyPair>
  key = await gen()
  otherKey = await gen()
  const jwk = (await crypto.subtle.exportKey('jwk', key.publicKey)) as JsonWebKey
  __setJwksForTest(TEAM, [{ ...jwk, kid: 'k1' }])
})

beforeEach(resetDb)

describe('/admin access control (defense in depth behind Cloudflare Access)', () => {
  it('no Cf-Access-Jwt-Assertion header → 403', async () => {
    expect((await call(adminReq('/admin'))).status).toBe(403)
    expect((await call(adminReq('/admin/api/site'))).status).toBe(403)
  })

  it('valid Access token → dashboard HTML', async () => {
    const res = await call(adminReq('/admin', await sign(claims())))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.text()).toContain('DevCol Analytics')
  })

  it.each([
    ['garbage token', async () => 'not.a.jwt'],
    ['wrong audience', () => sign(claims({ aud: ['someone-else'] }))],
    ['wrong issuer', () => sign(claims({ iss: 'https://evil.cloudflareaccess.com' }))],
    ['expired', () => sign(claims({ exp: Math.floor(Date.now() / 1000) - 10 }))],
    ['missing exp', () => sign(claims({ exp: undefined }))],
    ['signed by another key', () => sign(claims(), otherKey.privateKey)],
    ['unknown kid', () => sign(claims(), key.privateKey, 'k2')],
  ])('%s → 403', async (_, make) => {
    expect((await call(adminReq('/admin', await make()))).status).toBe(403)
  })

  it('Access not configured (no team/AUD secrets) → 403 even with a valid token', async () => {
    const token = await sign(claims())
    expect((await call(adminReq('/admin', token), testEnv({ ACCESS_AUD: undefined }))).status).toBe(403)
    expect((await call(adminReq('/admin', token), testEnv({ ACCESS_TEAM_DOMAIN: '' }))).status).toBe(403)
  })
})

describe('/admin/api', () => {
  it('site, games and realtime endpoints return data from collected events', async () => {
    await send(pv('/blog/a', { r: 'https://www.reddit.com/r/x', props: { entry: 1 } }))
    await send({ t: 'page_leave', p: '/blog/a', s: 'sess_abcdef12', props: { duration_ms: 4000, scroll_pct: 80 } })
    await send({ t: 'game_start', p: '/games/stack-up/index.html', s: 'sess_abcdef12' })
    await send({ t: 'game_over', p: '/games/stack-up/index.html', s: 'sess_abcdef12', props: { stage: 2, score: 20, duration_ms: 9000 } })
    await send({ t: 'game_over', p: '/games/stack-up/index.html', s: 'sess_abcdef12', props: { stage: 3, score: 35, duration_ms: 11000 } })
    const token = await sign(claims())

    const site = (await (await call(adminReq('/admin/api/site?days=7', token))).json()) as Record<string, unknown[]>
    expect(site.daily).toHaveLength(1)
    expect(site.top_pages).toEqual([{ path: '/blog/a', views: 1, visitors: 1 }])
    expect(site.referrers).toEqual([{ k: 'reddit.com', n: 1 }])
    expect(site.engagement).toEqual([{ path: '/blog/a', n: 1, avg_ms: 4000, avg_scroll: 80 }])

    const games = (await (await call(adminReq('/admin/api/games?days=30', token))).json()) as { games: Record<string, unknown>[] }
    expect(games.games[0]).toMatchObject({
      game: 'stack-up',
      opens: 1,
      runs: 2,
      avg_run_ms: 10000,
      best: 35,
      funnel: [
        { stage: 2, reached: 2, dropped: 1 },
        { stage: 3, reached: 1, dropped: 1 },
      ],
    })

    const live = (await (await call(adminReq('/admin/api/realtime', token))).json()) as Record<string, unknown>
    expect(live.events_30m).toBe(5)
    // 이 세션의 마지막 이벤트는 game_over → 아직 게임 페이지를 보고 있음
    expect(live.current_pages).toEqual([{ path: '/games/stack-up/index.html', viewers: 1 }])
  })

  it('POST aggregate (default today) feeds /public/summary', async () => {
    await send({ t: 'game_start', p: '/games/bug-squash/index.html', s: 'sess_abcdef12' })
    const token = await sign(claims())
    const res = await call(adminReq('/admin/api/aggregate', token, 'POST'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ day: kstDay(Date.now()), metrics: { 'plays:bug-squash': 1 } })
    const summary = (await (await call(new Request('https://a.devcol.net/public/summary'))).json()) as { games: unknown[] }
    expect(summary.games).toEqual([{ game: 'bug-squash', plays_total: '<5', best_score: 0 }])
  })

  it('aggregate rejects a malformed day; GET on it is 404', async () => {
    const token = await sign(claims())
    expect((await call(adminReq('/admin/api/aggregate?day=yesterday', token, 'POST'))).status).toBe(400)
    expect((await call(adminReq('/admin/api/aggregate', token))).status).toBe(404)
  })

  it('histogram buckets scores into at most 10 bins', () => {
    expect(histogram([])).toEqual([])
    const h = histogram([0, 1, 2, 50, 99])
    expect(h.length).toBeLessThanOrEqual(10)
    expect(h.reduce((a, b) => a + b.n, 0)).toBe(5)
    expect(histogram([7, 7])).toEqual([{ from: 7, to: 7, n: 2 }])
  })
})

describe('/admin/api/lb', () => {
  const lbSubmit = (name: string, score = 10, ip = `198.51.100.${Math.floor(Math.random() * 250)}`) =>
    call(
      new Request('https://a.devcol.net/lb/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Origin: 'https://devcol.net', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ game: 'stack-up', name, score, durationMs: 20_000 }),
      }),
    ).then((r) => r.json() as Promise<Record<string, unknown>>)

  async function act(body: Record<string, unknown>, token?: string, xAdmin = true) {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (token) headers.set('Cf-Access-Jwt-Assertion', token)
    if (xAdmin) headers.set('X-Admin', '1')
    return call(new Request('https://a.devcol.net/admin/api/lb/action', { method: 'POST', headers, body: JSON.stringify(body) }))
  }
  const topNames = async () =>
    ((await (await call(new Request('https://a.devcol.net/lb/top?game=stack-up'))).json()) as { entries: { name: string }[] }).entries.map((e) => e.name)

  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO lb_games (slug, max_score, max_score_per_sec, min_duration_ms, enabled, created_at) VALUES ('stack-up', 1e7, 0, 1000, 1, 0)",
    ).run()
  })

  it('every lb admin route needs a valid Access token; writes also need X-Admin', async () => {
    for (const p of ['entries', 'games', 'terms', 'usage']) expect((await call(adminReq(`/admin/api/lb/${p}`))).status).toBe(403)
    const { entryId } = await lbSubmit('Alpha')
    expect((await act({ action: 'hide', entryId })).status).toBe(403)
    const token = await sign(claims())
    expect((await act({ action: 'hide', entryId }, token, false)).status).toBe(403)
    expect((await act({ action: 'hide', entryId }, token)).status).toBe(200)
    expect(await topNames()).toEqual([])
  })

  it('entries list with filters and report counts', async () => {
    const token = await sign(claims())
    const a = await lbSubmit('Alpha', 5)
    await lbSubmit('fuck', 3)
    await call(
      new Request('https://a.devcol.net/lb/report', {
        method: 'POST',
        headers: { Origin: 'https://devcol.net', 'CF-Connecting-IP': '203.0.113.1' },
        body: JSON.stringify({ entryId: a.entryId }),
      }),
    )
    const list = async (q: string) =>
      ((await (await call(adminReq(`/admin/api/lb/entries${q}`, token))).json()) as { entries: Record<string, unknown>[] }).entries
    expect(await list('')).toHaveLength(2)
    expect(await list('?filter=reported')).toEqual([expect.objectContaining({ id: a.entryId, reports: 1, name: 'Alpha' })])
    expect((await list('?filter=renamed')).map((e) => e.name_status)).toEqual(['rules_fallback'])
    expect(await list('?q=Alph')).toHaveLength(1)
    expect(await list('?game=bug-squash')).toEqual([])
  })

  it('rename locks a neutral name; unlock clears reports; delete removes the row', async () => {
    const token = await sign(claims())
    const a = await lbSubmit('Alpha')
    await act({ action: 'rename', entryId: a.entryId }, token)
    const [name] = await topNames()
    expect(name).toMatch(/^Player\d{4}$/)
    expect(await env.DB.prepare('SELECT name_status, name_locked FROM lb_entries WHERE id = ?').bind(a.entryId).first()).toEqual({
      name_status: 'admin_renamed',
      name_locked: 1,
    })
    await act({ action: 'unlock', entryId: a.entryId }, token)
    expect((await env.DB.prepare('SELECT name_locked FROM lb_entries WHERE id = ?').bind(a.entryId).first<{ name_locked: number }>())!.name_locked).toBe(0)
    await act({ action: 'delete', entryId: a.entryId }, token)
    expect(await topNames()).toEqual([])
    expect((await act({ action: 'delete', entryId: a.entryId }, token)).status).toBe(404)
  })

  it('ban_owner renames all their rows and keeps future names neutral', async () => {
    const token = await sign(claims())
    const a = await lbSubmit('Alpha')
    await act({ action: 'ban_owner', entryId: a.entryId }, token)
    const res = await call(
      new Request('https://a.devcol.net/lb/submit', {
        method: 'POST',
        headers: { Origin: 'https://devcol.net', 'CF-Connecting-IP': '203.0.113.2' },
        body: JSON.stringify({ game: 'stack-up', name: 'Nice Name', score: 99, durationMs: 20_000, token: a.token }),
      }),
    )
    expect(await res.json()).toMatchObject({ nameStatus: 'banned_owner', publishedName: expect.stringMatching(/^Player\d{4}$/) })
  })

  it('ban_name and add_term rescan published names', async () => {
    const token = await sign(claims())
    await lbSubmit('Noobking')
    await lbSubmit('noob master')
    await lbSubmit('Clean')
    const res = await act({ action: 'add_term', term: 'noob' }, token)
    expect(await res.json()).toEqual({ renamed: 2 })
    expect((await topNames()).filter((n) => !/^Player\d{4}$/.test(n))).toEqual(['Clean'])
    const terms = (await (await call(adminReq('/admin/api/lb/terms', token))).json()) as { terms: { term: string }[] }
    expect(terms.terms.map((t) => t.term)).toEqual(['noob'])
    await act({ action: 'remove_term', term: 'noob' }, token)
    expect(((await (await call(adminReq('/admin/api/lb/terms', token))).json()) as { terms: unknown[] }).terms).toEqual([])

    const c = (await (await call(adminReq('/admin/api/lb/entries?q=Clean', token))).json()) as { entries: { id: number }[] }
    expect(await (await act({ action: 'ban_name', entryId: c.entries[0].id }, token)).json()).toEqual({ renamed: 1 })
    expect((await act({ action: 'add_term', term: '' }, token)).status).toBe(400)
    expect((await act({ action: 'nope' }, token)).status).toBe(400)
  })

  it('update_game edits bounds; usage reports the AI cap', async () => {
    const token = await sign(claims())
    expect((await act({ action: 'update_game', slug: 'stack-up', max_score: 50, max_score_per_sec: 0, min_duration_ms: 1000, stat_max: { stage: 5 } }, token)).status).toBe(200)
    expect((await act({ action: 'update_game', slug: 'missing', max_score: 1 }, token)).status).toBe(404)
    const games = (await (await call(adminReq('/admin/api/lb/games', token))).json()) as { games: Record<string, unknown>[] }
    expect(games.games[0]).toMatchObject({ slug: 'stack-up', max_score: 50, stat_max: '{"stage":5}', enabled: 1 })
    expect(await lbSubmit('Alpha', 60)).toEqual({ error: 'out_of_bounds' })
    const usage = await (await call(adminReq('/admin/api/lb/usage', token))).json()
    expect(usage).toMatchObject({ calls: expect.any(Number), cap: 1000, enabled: true })
  })
})
