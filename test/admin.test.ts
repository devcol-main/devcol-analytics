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
