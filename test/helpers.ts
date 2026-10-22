import { env } from 'cloudflare:test'
import worker from '../src/index'
import type { AppEnv } from '../src/env'

export const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
export const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

export const testEnv = (over: Partial<AppEnv> = {}): AppEnv => ({
  DB: env.DB,
  ALLOWED_ORIGINS: 'https://devcol.net,https://www.devcol.net',
  ALLOW_LOCALHOST: 'false',
  ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
  ACCESS_AUD: 'test-aud',
  ...over,
})

export function call(req: Request, e: AppEnv = testEnv()) {
  return worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, e)
}

interface SendOpts {
  origin?: string | null
  referer?: string
  ua?: string | null
  ip?: string
  country?: string
  raw?: string
}

export function collectReq(body: unknown, o: SendOpts = {}) {
  const headers = new Headers({ 'Content-Type': 'text/plain' })
  if (o.origin !== null) headers.set('Origin', o.origin ?? 'https://devcol.net')
  if (o.referer) headers.set('Referer', o.referer)
  if (o.ua !== null) headers.set('User-Agent', o.ua ?? UA_DESKTOP)
  headers.set('CF-Connecting-IP', o.ip ?? '203.0.113.7')
  return new Request('https://a.devcol.net/e', {
    method: 'POST',
    headers,
    body: o.raw ?? JSON.stringify(body),
    cf: { country: o.country ?? 'KR' },
  } as RequestInit)
}

export const send = (body: unknown, o: SendOpts = {}, e?: AppEnv) => call(collectReq(body, o), e)

export const pv = (p = '/blog/hello', extra: Record<string, unknown> = {}) => ({
  t: 'pageview',
  p,
  s: 'sess_abcdef12',
  props: {},
  ...extra,
})

export async function rows() {
  const { results } = await env.DB.prepare('SELECT * FROM events ORDER BY id').all<Record<string, unknown>>()
  return results
}

export async function resetDb() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM events'),
    env.DB.prepare('DELETE FROM daily_stats'),
    env.DB.prepare('DELETE FROM salts'),
  ])
}
