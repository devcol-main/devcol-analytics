import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { aggregateDay, runDailyCron, sourceName } from '../src/aggregate'
import { buildSummary } from '../src/public'
import { DAY_MS, dayStartMs } from '../src/util'
import { call, resetDb } from './helpers'

beforeEach(resetDb)

interface Ev {
  ts: number
  type: string
  path?: string
  visitor?: string
  session?: string
  game?: string | null
  ref?: string | null
  utm?: string | null
  props?: Record<string, unknown>
}

async function insert(...evs: Ev[]) {
  const stmt = env.DB.prepare(
    `INSERT INTO events (ts, type, path, referrer_host, utm_source, country, device, browser, visitor_hash, session_id, game, props)
     VALUES (?, ?, ?, ?, ?, 'KR', 'desktop', 'chrome', ?, ?, ?, ?)`,
  )
  await env.DB.batch(
    evs.map((e) =>
      stmt.bind(e.ts, e.type, e.path ?? '/', e.ref ?? null, e.utm ?? null, e.visitor ?? 'v1', e.session ?? 's1', e.game ?? null, e.props ? JSON.stringify(e.props) : null),
    ),
  )
}

async function stats(day: string) {
  const { results } = await env.DB.prepare('SELECT metric, value FROM daily_stats WHERE day = ?').bind(day).all<{ metric: string; value: number }>()
  return Object.fromEntries(results.map((r) => [r.metric, r.value]))
}

const DAY = '2026-10-20'
const T = dayStartMs(DAY) // 00:00 KST

describe('aggregateDay', () => {
  it('uses KST day boundaries: 23:59 KST counts, next 00:00 KST does not', async () => {
    await insert(
      { ts: T - 1, type: 'pageview' }, // 전날 23:59:59.999 KST
      { ts: T, type: 'pageview' },
      { ts: T + DAY_MS - 1, type: 'pageview' },
      { ts: T + DAY_MS, type: 'pageview' },
    )
    expect((await aggregateDay(env.DB, DAY)).pageviews).toBe(2)
  })

  it('pageviews, daily unique visitors, per-page and per-game metrics, entry sources', async () => {
    await insert(
      { ts: T + 1, type: 'pageview', path: '/blog/a', visitor: 'v1', utm: 'youtube', props: { entry: 1 } },
      { ts: T + 2, type: 'pageview', path: '/blog/a', visitor: 'v2', ref: 'youtu.be', props: { entry: 1 } },
      { ts: T + 3, type: 'pageview', path: '/blog/b', visitor: 'v2' },
      { ts: T + 4, type: 'pageview', path: '/', visitor: 'v3', props: { entry: 1 } },
      { ts: T + 5, type: 'game_start', path: '/games/new-game/index.html', visitor: 'v4', game: 'new-game' },
      { ts: T + 6, type: 'stage_clear', game: 'new-game', props: { stage: 1, score: 30 } },
      { ts: T + 7, type: 'game_over', game: 'new-game', props: { stage: 2, score: 55, duration_ms: 1000 } },
      { ts: T + 8, type: 'game_over', game: 'new-game', props: { stage: 1, score: 12, duration_ms: 500 } },
    )
    const m = await aggregateDay(env.DB, DAY)
    expect(m).toMatchObject({
      pageviews: 4,
      visitors: 4,
      'page:/blog/a': 2,
      'page:/blog/b': 1,
      'page:/': 1,
      'plays:new-game': 1,
      'runs:new-game': 2,
      'best:new-game': 55,
      'source:youtube': 2,
      'source:direct': 1,
    })
    expect(await stats(DAY)).toEqual(m)
  })

  it('re-running the same day overwrites instead of doubling', async () => {
    await insert({ ts: T + 1, type: 'pageview' })
    await aggregateDay(env.DB, DAY)
    await aggregateDay(env.DB, DAY)
    expect((await stats(DAY)).pageviews).toBe(1)
  })

  it('sourceName maps known hosts and keeps unknown ones', () => {
    expect(sourceName(null, 'm.youtube.com')).toBe('youtube')
    expect(sourceName(null, 't.co')).toBe('x')
    expect(sourceName(null, 'google.co.kr')).toBe('google')
    expect(sourceName(null, 'example.org')).toBe('example.org')
    expect(sourceName('newsletter', 'google.com')).toBe('newsletter')
    expect(sourceName(null, null)).toBe('direct')
  })
})

describe('runDailyCron', () => {
  it('aggregates yesterday, deletes raw events older than 90 days and salts older than 2 days', async () => {
    const now = dayStartMs('2026-10-21') + 10 * 60_000 // 2026-10-21 00:10 KST
    await insert(
      { ts: now - DAY_MS + 5, type: 'pageview' }, // 어제
      { ts: now - 91 * DAY_MS, type: 'pageview' }, // 91일 전
    )
    await env.DB.batch(
      ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'].map((d) => env.DB.prepare('INSERT INTO salts VALUES (?, ?)').bind(d, 'x')),
    )
    await runDailyCron(env.DB, now)
    expect((await stats('2026-10-20')).pageviews).toBe(1)
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!
    expect(n).toBe(1)
    const { results } = await env.DB.prepare('SELECT day FROM salts ORDER BY day').all<{ day: string }>()
    expect(results.map((r) => r.day)).toEqual(['2026-10-20', '2026-10-21'])
  })
})

describe('public summary', () => {
  async function seedStats(rows: [string, string, number][]) {
    await env.DB.batch(rows.map(([d, m, v]) => env.DB.prepare('INSERT INTO daily_stats VALUES (?, ?, ?)').bind(d, m, v)))
  }

  it('values under 5 are shown as "<5"; games listed dynamically from data', async () => {
    await seedStats([
      ['2026-10-20', 'pageviews', 3],
      ['2026-10-20', 'visitors', 2],
      ['2026-10-20', 'page:/blog/a', 4],
      ['2026-10-20', 'plays:zeta-game', 2],
      ['2026-10-20', 'best:zeta-game', 99],
    ])
    const s = await buildSummary(env.DB)
    expect(s).toMatchObject({
      updated: '2026-10-20',
      since: '2026-10-20',
      pageviews_30d: '<5',
      visitors_30d: '<5',
      top_posts_30d: [{ path: '/blog/a', views: '<5' }],
      games: [{ game: 'zeta-game', plays_total: '<5', best_score: 99 }],
    })
  })

  it('30-day window ends at the last aggregated day; game totals are all-time', async () => {
    await seedStats([
      ['2026-09-01', 'pageviews', 100],
      ['2026-09-01', 'plays:stack-up', 10],
      ['2026-10-01', 'pageviews', 20],
      ['2026-10-20', 'pageviews', 30],
      ['2026-10-20', 'plays:stack-up', 5],
      ['2026-10-20', 'best:stack-up', 42],
      ['2026-09-01', 'best:stack-up', 50],
    ])
    const s = await buildSummary(env.DB)
    expect(s.pageviews_30d).toBe(50)
    expect(s.games).toEqual([{ game: 'stack-up', plays_total: 15, best_score: 50 }])
  })

  it('sources under 5 are merged into "other" and shares sum to ~1', async () => {
    await seedStats([
      ['2026-10-20', 'source:youtube', 10],
      ['2026-10-20', 'source:direct', 6],
      ['2026-10-20', 'source:tiny-blog.example', 2],
      ['2026-10-20', 'source:x', 2],
    ])
    const s = await buildSummary(env.DB)
    expect(s.top_sources_30d).toEqual([
      { source: 'youtube', share: 0.5 },
      { source: 'direct', share: 0.3 },
      { source: 'other', share: 0.2 },
    ])
  })

  it('exposes no per-visitor data (hashes, session ids, countries, raw rows)', async () => {
    await insert(
      { ts: T + 1, type: 'pageview', path: '/blog/a', visitor: 'secret-visitor-hash', session: 'secret-session', props: { title: 'Post A' } },
    )
    await aggregateDay(env.DB, DAY)
    const res = await call(new Request('https://a.devcol.net/public/summary', { headers: { Origin: 'https://devcol.net' } }))
    const text = await res.text()
    expect(text).not.toContain('secret-visitor-hash')
    expect(text).not.toContain('secret-session')
    expect(text).not.toMatch(/"KR"|desktop|chrome|visitor_hash|session_id|country/)
    expect(JSON.parse(text).top_posts_30d).toEqual([{ path: '/blog/a', title: 'Post A', views: '<5' }])
  })

  it('HTTP: cacheable for an hour, CORS only for devcol.net', async () => {
    const ok = await call(new Request('https://a.devcol.net/public/summary', { headers: { Origin: 'https://devcol.net' } }))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://devcol.net')
    const other = await call(new Request('https://a.devcol.net/public/summary', { headers: { Origin: 'https://evil.example' } }))
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('empty database → valid empty summary', async () => {
    const s = await buildSummary(env.DB)
    expect(s).toMatchObject({ updated: null, pageviews_30d: '<5', top_posts_30d: [], games: [], top_sources_30d: [] })
  })
})
