import { matchOrigin } from './util'
import type { AppEnv } from './env'

export const MAX_BODY_BYTES = 2048
export const MAX_PROPS_BYTES = 1024
export const RATE_LIMIT_PER_MIN = 60

export const EVENT_TYPES = ['pageview', 'page_leave', 'game_start', 'stage_clear', 'game_over', 'custom'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export type PropValue = string | number | boolean | null
export interface Payload {
  t: EventType
  p: string
  r: string | null
  s: string
  props: Record<string, PropValue>
}

const BOT_UA =
  /bot|crawl|spider|slurp|headless|preview|lighthouse|pingdom|uptime|monitor|curl|wget|python|httpclient|axios|node-fetch|undici|go-http|java\/|okhttp|scrapy|phantom|selenium|puppeteer|playwright|facebookexternalhit|embedly|whatsapp|telegram/i

export function isBotUA(ua: string | null): boolean {
  return !ua || BOT_UA.test(ua)
}

/** Origin(없으면 Referer의 origin)이 devcol.net 계열인지. localhost는 ALLOW_LOCALHOST일 때만. */
export function originAllowed(req: Request, env: Pick<AppEnv, 'ALLOWED_ORIGINS' | 'ALLOW_LOCALHOST'>): boolean {
  let origin = req.headers.get('Origin')
  if (!origin || origin === 'null') {
    const ref = req.headers.get('Referer')
    if (!ref) return false
    try {
      origin = new URL(ref).origin
    } catch {
      return false
    }
  }
  return matchOrigin(origin, env) !== null
}

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/

/** 필수 필드/타입/크기 검증. 통과하면 정규화된 payload, 아니면 null. */
export function validatePayload(raw: unknown): Payload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.t !== 'string' || !(EVENT_TYPES as readonly string[]).includes(o.t)) return null
  if (typeof o.p !== 'string' || !o.p.startsWith('/') || o.p.length > 512) return null
  if (typeof o.s !== 'string' || !SESSION_RE.test(o.s)) return null
  if (o.r != null && (typeof o.r !== 'string' || o.r.length > 1024)) return null

  const props: Record<string, PropValue> = {}
  if (o.props != null) {
    if (typeof o.props !== 'object' || Array.isArray(o.props)) return null
    const entries = Object.entries(o.props as Record<string, unknown>)
    if (entries.length > 20) return null
    for (const [k, v] of entries) {
      if (k.length > 40) return null
      if (v === null || typeof v === 'boolean' || typeof v === 'string') props[k] = v
      else if (typeof v === 'number' && Number.isFinite(v)) props[k] = v
      else return null
    }
    if (new TextEncoder().encode(JSON.stringify(props)).length > MAX_PROPS_BYTES) return null
  }
  return { t: o.t as EventType, p: o.p.split(/[?#]/)[0] || '/', r: (o.r as string) || null, s: o.s, props }
}

/** 같은 visitor_hash가 최근 1분간 RATE_LIMIT_PER_MIN건 이상이면 true (= 이번 건 드롭) */
export async function isRateLimited(db: D1Database, visitorHash: string, now: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE visitor_hash = ? AND ts > ?')
    .bind(visitorHash, now - 60_000)
    .first<{ n: number }>()
  return (row?.n ?? 0) >= RATE_LIMIT_PER_MIN
}
