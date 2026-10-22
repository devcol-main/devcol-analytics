import { beforeEach, describe, expect, it } from 'vitest'
import { browserOf, deviceOf, gameFromPath, referrerHost } from '../src/collect'
import { UA_IPHONE, pv, resetDb, rows, send, testEnv } from './helpers'

beforeEach(resetDb)

describe('POST /e — 정상 수집', () => {
  it('valid pageview from devcol.net → one row with server-derived fields', async () => {
    const res = await send(pv('/blog/hello', { r: 'https://www.youtube.com/watch?v=x', props: { utm_source: 'YouTube', entry: 1 } }))
    expect(res.status).toBe(204)
    const [row] = await rows()
    expect(row).toMatchObject({
      type: 'pageview',
      path: '/blog/hello',
      referrer_host: 'youtube.com',
      utm_source: 'youtube',
      country: 'KR',
      device: 'desktop',
      browser: 'chrome',
      session_id: 'sess_abcdef12',
      game: null,
    })
    expect(row.visitor_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof row.ts).toBe('number')
  })

  it('stores no raw IP or full UA anywhere in the row', async () => {
    await send(pv(), { ip: '198.51.100.23' })
    const [row] = await rows()
    const flat = JSON.stringify(row)
    expect(flat).not.toContain('198.51.100.23')
    expect(flat).not.toContain('Macintosh')
  })

  it('www.devcol.net origin is accepted too', async () => {
    await send(pv(), { origin: 'https://www.devcol.net' })
    expect(await rows()).toHaveLength(1)
  })

  it('missing Origin falls back to the Referer origin', async () => {
    await send(pv(), { origin: null, referer: 'https://devcol.net/blog/hello' })
    expect(await rows()).toHaveLength(1)
  })

  it('query string and hash are stripped from the path', async () => {
    await send(pv('/blog/hello?utm_source=x#top'))
    expect((await rows())[0].path).toBe('/blog/hello')
  })

  it('internal referrer (devcol.net) is not stored as a source', async () => {
    await send(pv('/blog/a', { r: 'https://devcol.net/' }))
    expect((await rows())[0].referrer_host).toBeNull()
  })

  it('same IP+UA on the same day → same visitor_hash; different IP → different', async () => {
    await send(pv(), { ip: '203.0.113.1' })
    await send(pv(), { ip: '203.0.113.1' })
    await send(pv(), { ip: '203.0.113.2' })
    const [a, b, c] = await rows()
    expect(a.visitor_hash).toBe(b.visitor_hash)
    expect(a.visitor_hash).not.toBe(c.visitor_hash)
  })
})

describe('POST /e — 게임 ID 자동 추출 (6-1)', () => {
  it('/games/<slug>/... path → game = slug for any slug (no hardcoded list)', async () => {
    await send({ t: 'game_start', p: '/games/brand-new-game/index.html', s: 'sess_abcdef12' })
    await send({ t: 'stage_clear', p: '/games/stack-up/', s: 'sess_abcdef12', props: { stage: 3, score: 40 } })
    const [a, b] = await rows()
    expect(a.game).toBe('brand-new-game')
    expect(b.game).toBe('stack-up')
    expect(JSON.parse(b.props as string)).toMatchObject({ stage: 3, score: 40, game: 'stack-up' })
  })

  it('path wins over a spoofed props.game', async () => {
    await send({ t: 'game_over', p: '/games/bug-squash/index.html', s: 'sess_abcdef12', props: { game: 'other' } })
    expect((await rows())[0].game).toBe('bug-squash')
  })

  it('unit helpers', () => {
    expect(gameFromPath('/games/x1/index.html')).toBe('x1')
    expect(gameFromPath('/games/')).toBeNull()
    expect(gameFromPath('/blog/games/x')).toBeNull()
    expect(deviceOf(UA_IPHONE)).toBe('mobile')
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet')
    expect(browserOf(UA_IPHONE)).toBe('safari')
    expect(referrerHost('not a url', testEnv())).toBeNull()
  })
})

describe('POST /e — 봇/스팸 필터 (bot.ts)', () => {
  it('foreign origin → ignored', async () => {
    const res = await send(pv(), { origin: 'https://evil.example' })
    expect(res.status).toBe(204)
    expect(await rows()).toHaveLength(0)
  })

  it('no Origin and no Referer → ignored', async () => {
    await send(pv(), { origin: null })
    expect(await rows()).toHaveLength(0)
  })

  it('localhost ignored by default, accepted in test mode (ALLOW_LOCALHOST)', async () => {
    await send(pv(), { origin: 'http://localhost:5173' })
    expect(await rows()).toHaveLength(0)
    await send(pv(), { origin: 'http://localhost:5173' }, testEnv({ ALLOW_LOCALHOST: 'true' }))
    expect(await rows()).toHaveLength(1)
  })

  it.each([
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Discordbot/2.0)',
    'curl/8.4.0',
    'facebookexternalhit/1.1',
  ])('bot UA %s → ignored', async (ua) => {
    await send(pv(), { ua })
    expect(await rows()).toHaveLength(0)
  })

  it('missing UA → ignored', async () => {
    await send(pv(), { ua: null })
    expect(await rows()).toHaveLength(0)
  })

  it('body over 2KB → ignored', async () => {
    await send(null, { raw: JSON.stringify({ ...pv(), r: 'https://x.com/' + 'a'.repeat(2100) }) })
    expect(await rows()).toHaveLength(0)
  })

  it('custom props over 1KB → ignored', async () => {
    await send({ t: 'custom', p: '/', s: 'sess_abcdef12', props: { blob: 'x'.repeat(1100) } })
    expect(await rows()).toHaveLength(0)
  })

  it.each([
    ['unknown type', { t: 'purchase', p: '/', s: 'sess_abcdef12' }],
    ['missing path', { t: 'pageview', s: 'sess_abcdef12' }],
    ['relative path', { t: 'pageview', p: 'blog', s: 'sess_abcdef12' }],
    ['bad session id', { t: 'pageview', p: '/', s: 'x' }],
    ['nested props', { t: 'custom', p: '/', s: 'sess_abcdef12', props: { a: { b: 1 } } }],
    ['array body', [1, 2]],
  ])('invalid payload (%s) → ignored', async (_, body) => {
    await send(body)
    expect(await rows()).toHaveLength(0)
  })

  it('malformed JSON → ignored', async () => {
    await send(null, { raw: '{not json' })
    expect(await rows()).toHaveLength(0)
  })

  it('more than 60 events/min from one visitor → extra dropped', async () => {
    for (let i = 0; i < 65; i++) await send(pv(`/p${i}`))
    expect(await rows()).toHaveLength(60)
    await send(pv(), { ip: '203.0.113.99' })
    expect(await rows()).toHaveLength(61)
  })
})

describe('routing', () => {
  it('GET /e → 405, unknown path → 404', async () => {
    const { call } = await import('./helpers')
    expect((await call(new Request('https://a.devcol.net/e'))).status).toBe(405)
    expect((await call(new Request('https://a.devcol.net/nope'))).status).toBe(404)
  })
})
