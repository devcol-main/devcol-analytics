const KST_OFFSET = 9 * 3600 * 1000
export const DAY_MS = 86_400_000

/** epoch ms → KST 날짜 (YYYY-MM-DD) */
export function kstDay(ms: number): string {
  return new Date(ms + KST_OFFSET).toISOString().slice(0, 10)
}

/** KST 날짜 → 그날 00:00 KST의 epoch ms */
export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - KST_OFFSET
}

export function addDays(day: string, n: number): string {
  return kstDay(dayStartMs(day) + n * DAY_MS)
}

export const isDay = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 허용 Origin이면 그 값을, 아니면 null (CORS 응답용) */
export function matchOrigin(origin: string | null, env: { ALLOWED_ORIGINS: string; ALLOW_LOCALHOST: string }): string | null {
  if (!origin) return null
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  if (allowed.includes(origin)) return origin
  if (env.ALLOW_LOCALHOST === 'true' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
  return null
}
