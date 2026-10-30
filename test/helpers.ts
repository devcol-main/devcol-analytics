import { env } from 'cloudflare:test'
import worker from '../src/index'
import type { AppEnv } from '../src/env'

export const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
export const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** 가짜 Workers AI. reply(이름)이 모델 답 텍스트를 정한다 (기본: 모두 SAFE). 부른 이름은 calls에 쌓인다. */
export function fakeAi(reply: (name: string) => string | Promise<string> = () => 'SAFE') {
  const calls: string[] = []
  const ai = {
    calls,
    async run(_model: string, input: { messages: { role: string; content: string }[] }) {
      const user = input.messages.find((m) => m.role === 'user')?.content ?? ''
      const name = /"(.*)"/.exec(user)?.[1] ?? user
      calls.push(name)
      return { response: await reply(name) }
    },
  }
  return ai as typeof ai & Ai
}

export const testEnv = (over: Partial<AppEnv> = {}): AppEnv => ({
  DB: env.DB,
  ALLOWED_ORIGINS: 'https://devcol.net,https://www.devcol.net',
  ALLOW_LOCALHOST: 'false',
  ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
  ACCESS_AUD: 'test-aud',
  AI: fakeAi(),
  AI_MODERATION: 'on',
  AI_DAILY_CAP: '1000',
  SITE_ORIGIN: 'https://devcol.net',
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
    ...['lb_games', 'lb_owners', 'lb_entries', 'lb_names', 'lb_terms', 'lb_reports', 'lb_ai_usage', 'lb_rate'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  ])
}
