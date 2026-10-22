import type { AppEnv } from './env'
import { MAX_BODY_BYTES, isBotUA, isRateLimited, originAllowed, validatePayload } from './bot'
import { kstDay, matchOrigin, randomHex, sha256Hex } from './util'

// 무시한 요청도 204로 답한다 (클라이언트에 필터 기준을 드러내지 않음)
const noContent = (origin: string | null) => {
  const headers = new Headers()
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  return new Response(null, { status: 204, headers })
}

const GAME_PATH_RE = /^\/games\/([a-z0-9][a-z0-9-]{0,40})(?:\/|$)/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/

/** `/games/<slug>/...` → slug. 게임 목록은 하드코딩하지 않는다. */
export function gameFromPath(path: string): string | null {
  return GAME_PATH_RE.exec(path)?.[1] ?? null
}

export function deviceOf(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet'
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile'
  return 'desktop'
}

export function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return 'edge'
  if (/OPR\/|Opera/.test(ua)) return 'opera'
  if (/SamsungBrowser/.test(ua)) return 'samsung'
  if (/Firefox|FxiOS/.test(ua)) return 'firefox'
  if (/Chrome|CriOS|Chromium/.test(ua)) return 'chrome'
  if (/Safari/.test(ua)) return 'safari'
  return 'other'
}

/** 외부 유입 도메인만 (www. 제거). 자기 사이트/로컬/파싱 실패면 null. */
export function referrerHost(r: string | null, env: Pick<AppEnv, 'ALLOWED_ORIGINS'>): string | null {
  if (!r) return null
  let host: string
  try {
    host = new URL(r).hostname.toLowerCase()
  } catch {
    return null
  }
  const own = env.ALLOWED_ORIGINS.split(',').map((o) => {
    try {
      return new URL(o.trim()).hostname
    } catch {
      return ''
    }
  })
  if (own.includes(host) || host === 'localhost' || host === '127.0.0.1') return null
  return host.replace(/^www\./, '').slice(0, 253) || null
}

let saltCache: { day: string; salt: string } | null = null

/** 그날(KST)의 솔트. 없으면 만든다. 동시 생성 경쟁은 INSERT OR IGNORE로 해결. */
export async function dailySalt(db: D1Database, day: string): Promise<string> {
  if (saltCache?.day === day) return saltCache.salt
  await db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').bind(day, randomHex(32)).run()
  const row = await db.prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first<{ salt: string }>()
  if (!row) throw new Error('salt missing')
  saltCache = { day, salt: row.salt }
  return row.salt
}

export async function handleCollect(req: Request, env: AppEnv): Promise<Response> {
  const corsOrigin = matchOrigin(req.headers.get('Origin'), env)
  if (!originAllowed(req, env)) return noContent(null)

  const ua = req.headers.get('User-Agent')
  if (isBotUA(ua)) return noContent(corsOrigin)

  const declared = Number(req.headers.get('Content-Length') ?? '0')
  if (declared > MAX_BODY_BYTES) return noContent(corsOrigin)
  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return noContent(corsOrigin)

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return noContent(corsOrigin)
  }
  const payload = validatePayload(raw)
  if (!payload) return noContent(corsOrigin)

  const now = Date.now()
  const salt = await dailySalt(env.DB, kstDay(now))
  const ip = req.headers.get('CF-Connecting-IP') ?? ''
  const visitorHash = await sha256Hex(`${ip}|${ua}|${salt}`)
  if (await isRateLimited(env.DB, visitorHash, now)) return noContent(corsOrigin)

  const { props } = payload
  const propGame = typeof props.game === 'string' && SLUG_RE.test(props.game) ? props.game : null
  const game = gameFromPath(payload.p) ?? propGame
  if (game) props.game = game
  const utm = typeof props.utm_source === 'string' ? props.utm_source.toLowerCase().slice(0, 64) : null
  const country = typeof req.cf?.country === 'string' ? req.cf.country : null

  await env.DB.prepare(
    `INSERT INTO events (ts, type, path, referrer_host, utm_source, country, device, browser, visitor_hash, session_id, game, props)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now,
      payload.t,
      payload.p,
      referrerHost(payload.r, env),
      utm,
      country,
      deviceOf(ua!),
      browserOf(ua!),
      visitorHash,
      payload.s,
      game,
      Object.keys(props).length ? JSON.stringify(props) : null,
    )
    .run()

  return noContent(corsOrigin)
}
