// 공개 리더보드 API: POST /lb/submit, GET /lb/top, POST /lb/delete, POST /lb/report
// 클라이언트 게임은 조작할 수 있다. 여기 검사는 치팅을 막지 못하고 수고와 피해 범위만 줄인다.
import type { AppEnv } from '../env'
import { originAllowed } from '../bot'
import { dailySalt } from '../collect'
import { json, kstDay, matchOrigin, randomHex, sha256Hex } from '../util'
import { aiCheckName } from './ai'
import { checkRules, fallbackName, nameKey } from './moderation'

export const MAX_LB_BODY = 2048
export const TOP_MAX = 50
export const SUBMIT_PER_MIN = 10
export const REPORT_PER_MIN = 5
export const NEW_OWNER_PER_HOUR = 3
export const REPORT_THRESHOLD = 3
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const TOKEN_RE = /^[0-9a-f]{64}$/

/** 새 게임이 처음 등록될 때의 기본 bound. 넉넉하게 두고 /admin에서 게임별로 조인다. */
export const DEFAULT_GAME_BOUNDS = { max_score: 10_000_000, max_score_per_sec: 0, min_duration_ms: 1000 }

export type NameStatus =
  | 'ok'
  | 'unchecked_ai'
  | 'rules_fallback'
  | 'ai_fallback'
  | 'banned_owner'
  | 'reported'
  | 'admin_renamed'

function cors(req: Request, env: AppEnv): Record<string, string> {
  const origin = matchOrigin(req.headers.get('Origin'), env)
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' }
}

const reply = (req: Request, env: AppEnv, data: unknown, status = 200, extra: Record<string, string> = {}) =>
  json(data, { status, headers: { 'Cache-Control': 'no-store', ...cors(req, env), ...extra } })

export function lbPreflight(req: Request, env: AppEnv): Response {
  return new Response(null, {
    status: 204,
    headers: { ...cors(req, env), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' },
  })
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get('Content-Length') ?? '0') > MAX_LB_BODY) return null
  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_LB_BODY) return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 방문자 집계와 같은 하루 솔트 해시. IP 원문은 저장하지 않는다. */
async function clientHash(req: Request, env: AppEnv, now: number): Promise<string> {
  const salt = await dailySalt(env.DB, kstDay(now))
  return sha256Hex(`${req.headers.get('CF-Connecting-IP') ?? ''}|${req.headers.get('User-Agent') ?? ''}|${salt}`)
}

/** windowMs 안에 key로 limit건 이상이면 true. 아니면 이번 건을 기록하고 false. */
export async function rateLimited(db: D1Database, key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM lb_rate WHERE key = ? AND ts > ?').bind(key, now - windowMs).first<{ n: number }>()
  if ((row?.n ?? 0) >= limit) return true
  await db.prepare('INSERT INTO lb_rate (key, ts) VALUES (?, ?)').bind(key, now).run()
  return false
}

// ---------- 게임 (slug는 데이터에서만) ----------

export interface GameRow {
  slug: string
  max_score: number
  max_score_per_sec: number
  min_duration_ms: number
  stat_max: string | null
  enabled: number
}

/** 사이트에 /games/<slug>/ 페이지가 있으면 기본 bound로 등록한다. 없으면 null. */
async function findOrRegisterGame(env: AppEnv, slug: string, now: number): Promise<GameRow | null> {
  const row = await env.DB.prepare('SELECT * FROM lb_games WHERE slug = ?').bind(slug).first<GameRow>()
  if (row) return row
  const site = (env.SITE_ORIGIN || 'https://devcol.net').replace(/\/+$/, '')
  try {
    const res = await fetch(`${site}/games/${slug}/`, { method: 'GET', redirect: 'follow' })
    if (!res.ok) return null
  } catch {
    return null
  }
  const b = DEFAULT_GAME_BOUNDS
  await env.DB.prepare(
    'INSERT OR IGNORE INTO lb_games (slug, max_score, max_score_per_sec, min_duration_ms, stat_max, enabled, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)',
  )
    .bind(slug, b.max_score, b.max_score_per_sec, b.min_duration_ms, now)
    .run()
  return env.DB.prepare('SELECT * FROM lb_games WHERE slug = ?').bind(slug).first<GameRow>()
}

export interface Submission {
  game: string
  name: string
  score: number
  stats: Record<string, number>
  durationMs: number
  token: string | null
}

export function validateSubmission(o: Record<string, unknown>): Submission | null {
  if (typeof o.game !== 'string' || !SLUG_RE.test(o.game)) return null
  if (typeof o.name !== 'string' || o.name.length > 64) return null
  if (typeof o.score !== 'number' || !Number.isFinite(o.score) || o.score < 0) return null
  if (typeof o.durationMs !== 'number' || !Number.isFinite(o.durationMs) || o.durationMs < 0) return null
  const stats: Record<string, number> = {}
  if (o.stats != null) {
    if (typeof o.stats !== 'object' || Array.isArray(o.stats)) return null
    const entries = Object.entries(o.stats as Record<string, unknown>)
    if (entries.length > 10) return null
    for (const [k, v] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) return null
      stats[k] = v
    }
  }
  let token: string | null = null
  if (o.token != null) {
    if (typeof o.token !== 'string' || !TOKEN_RE.test(o.token)) return null
    token = o.token
  }
  return { game: o.game, name: o.name, score: o.score, stats, durationMs: Math.round(o.durationMs), token }
}

/** 게임별 sanity bound. 넘으면 저장하지 않는다. */
export function withinBounds(g: GameRow, s: Submission): boolean {
  if (s.score > g.max_score) return false
  if (s.durationMs < g.min_duration_ms) return false
  if (g.max_score_per_sec > 0 && s.score / Math.max(s.durationMs / 1000, 0.001) > g.max_score_per_sec) return false
  if (g.stat_max) {
    let max: Record<string, unknown>
    try {
      max = JSON.parse(g.stat_max) as Record<string, unknown>
    } catch {
      return true
    }
    for (const [k, v] of Object.entries(s.stats)) {
      const m = max[k]
      if (typeof m === 'number' && (v < 0 || v > m)) return false
    }
  }
  return true
}

// ---------- 닉네임 판정 ----------

async function extraTerms(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT term FROM lb_terms').all<{ term: string }>()
  return results.map((r) => r.term)
}

/** 규칙 → (캐시 또는) AI. AI를 못 쓰면 규칙 결과로 공개하고 unchecked_ai로 남긴다 (cron이 나중에 다시 본다). */
export async function moderateName(
  env: AppEnv,
  raw: string,
  ownerId: string,
  now: number,
  terms?: string[],
): Promise<{ name: string; status: NameStatus }> {
  const rules = checkRules(raw, terms ?? (await extraTerms(env.DB)))
  if (!rules.ok) return { name: await fallbackName(ownerId), status: 'rules_fallback' }
  const name = rules.name!
  const key = nameKey(name)
  const cached = await env.DB.prepare('SELECT verdict FROM lb_names WHERE name_key = ?').bind(key).first<{ verdict: string }>()
  let verdict = cached?.verdict
  if (!verdict) {
    const ai = await aiCheckName(env, name, now)
    if (ai !== 'unknown') {
      verdict = ai
      await env.DB.prepare('INSERT OR REPLACE INTO lb_names (name_key, verdict, checked_at) VALUES (?, ?, ?)').bind(key, ai, now).run()
    }
  }
  if (verdict === 'unsafe') return { name: await fallbackName(ownerId), status: 'ai_fallback' }
  return { name, status: verdict === 'safe' ? 'ok' : 'unchecked_ai' }
}

// ---------- 핸들러 ----------

interface OwnerRow {
  id: string
  banned: number
}

export async function handleSubmit(req: Request, env: AppEnv): Promise<Response> {
  if (!originAllowed(req, env)) return reply(req, env, { error: 'forbidden' }, 403)
  const body = await readBody(req)
  const sub = body && validateSubmission(body)
  if (!sub) return reply(req, env, { error: 'bad_request' }, 400)

  const now = Date.now()
  const who = await clientHash(req, env, now)
  if (await rateLimited(env.DB, `submit:${who}`, SUBMIT_PER_MIN, 60_000, now)) return reply(req, env, { error: 'rate_limited' }, 429)

  const game = await findOrRegisterGame(env, sub.game, now)
  if (!game) return reply(req, env, { error: 'unknown_game' }, 404)
  if (!game.enabled) return reply(req, env, { error: 'game_disabled' }, 403)
  if (!withinBounds(game, sub)) return reply(req, env, { error: 'out_of_bounds' }, 422)

  // owner: 토큰이 있고 알려진 것이면 그 owner, 아니면 새로 만든다 (삭제된 토큰이면 새 토큰을 받는다)
  let owner: OwnerRow | null = null
  if (sub.token) {
    owner = await env.DB.prepare('SELECT id, banned FROM lb_owners WHERE token_hash = ?').bind(await sha256Hex(sub.token)).first<OwnerRow>()
  }
  let newToken: string | null = null
  if (owner) {
    await env.DB.prepare('UPDATE lb_owners SET last_seen = ? WHERE id = ?').bind(now, owner.id).run()
  } else {
    if (await rateLimited(env.DB, `owner:${who}`, NEW_OWNER_PER_HOUR, 3600_000, now)) return reply(req, env, { error: 'rate_limited' }, 429)
    newToken = randomHex(32)
    owner = { id: randomHex(16), banned: 0 }
    await env.DB.prepare('INSERT INTO lb_owners (id, token_hash, banned, created_at, last_seen) VALUES (?, ?, 0, ?, ?)')
      .bind(owner.id, await sha256Hex(newToken), now, now)
      .run()
  }

  const prev = await env.DB.prepare('SELECT id, score, name, name_status, name_locked FROM lb_entries WHERE owner_id = ? AND game = ?')
    .bind(owner.id, sub.game)
    .first<{ id: number; score: number; name: string; name_status: NameStatus; name_locked: number }>()

  let published: { name: string; status: NameStatus }
  if (owner.banned) published = { name: await fallbackName(owner.id), status: 'banned_owner' }
  else if (prev?.name_locked) published = { name: prev.name, status: prev.name_status }
  else published = await moderateName(env, sub.name, owner.id, now)

  const stats = Object.keys(sub.stats).length ? JSON.stringify(sub.stats) : null
  let entryId: number
  let best = sub.score
  if (!prev) {
    const row = await env.DB.prepare(
      `INSERT INTO lb_entries (game, owner_id, name, name_status, score, stats, duration_ms, ts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(sub.game, owner.id, published.name, published.status, sub.score, stats, sub.durationMs, now, now)
      .first<{ id: number }>()
    entryId = row!.id
  } else {
    entryId = prev.id
    if (sub.score > prev.score) {
      await env.DB.prepare('UPDATE lb_entries SET name = ?, name_status = ?, score = ?, stats = ?, duration_ms = ?, ts = ?, updated_at = ? WHERE id = ?')
        .bind(published.name, published.status, sub.score, stats, sub.durationMs, now, now, entryId)
        .run()
    } else {
      best = prev.score
      await env.DB.prepare('UPDATE lb_entries SET name = ?, name_status = ?, updated_at = ? WHERE id = ?')
        .bind(published.name, published.status, now, entryId)
        .run()
    }
  }

  const rank = await env.DB.prepare('SELECT COUNT(*) + 1 AS r FROM lb_entries WHERE game = ? AND hidden = 0 AND score > ?')
    .bind(sub.game, best)
    .first<{ r: number }>()

  const out: Record<string, unknown> = { entryId, publishedName: published.name, nameStatus: published.status, best, rank: rank?.r ?? null }
  if (newToken) out.token = newToken
  return reply(req, env, out)
}

export async function handleTop(req: Request, env: AppEnv): Promise<Response> {
  const url = new URL(req.url)
  const game = url.searchParams.get('game') ?? ''
  if (!SLUG_RE.test(game)) return reply(req, env, { error: 'bad_request' }, 400)
  const n = Math.min(TOP_MAX, Math.max(1, Math.floor(Number(url.searchParams.get('n')) || 10)))
  const { results } = await env.DB.prepare(
    'SELECT id, name, score, stats, ts FROM lb_entries WHERE game = ? AND hidden = 0 ORDER BY score DESC, ts ASC LIMIT ?',
  )
    .bind(game, n)
    .all<{ id: number; name: string; score: number; stats: string | null; ts: number }>()
  const entries = results.map((r) => ({ id: r.id, name: r.name, score: r.score, stats: r.stats ? (JSON.parse(r.stats) as unknown) : {}, ts: r.ts }))
  return reply(req, env, { game, entries })
}

export async function handleDelete(req: Request, env: AppEnv): Promise<Response> {
  if (!originAllowed(req, env)) return reply(req, env, { error: 'forbidden' }, 403)
  const body = await readBody(req)
  const token = body?.token
  const game = body?.game
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return reply(req, env, { error: 'bad_request' }, 400)
  if (game != null && (typeof game !== 'string' || !SLUG_RE.test(game))) return reply(req, env, { error: 'bad_request' }, 400)

  const owner = await env.DB.prepare('SELECT id FROM lb_owners WHERE token_hash = ?').bind(await sha256Hex(token)).first<{ id: string }>()
  if (!owner) return reply(req, env, { error: 'not_found' }, 404)
  const deleted = await deleteOwnerEntries(env.DB, owner.id, typeof game === 'string' ? game : null)
  return reply(req, env, { deleted })
}

/** owner의 기록 삭제. game이 없으면 owner(토큰)까지 지운다. */
export async function deleteOwnerEntries(db: D1Database, ownerId: string, game: string | null): Promise<number> {
  const where = game ? 'owner_id = ? AND game = ?' : 'owner_id = ?'
  const args = game ? [ownerId, game] : [ownerId]
  const [, del] = await db.batch([
    db.prepare(`DELETE FROM lb_reports WHERE entry_id IN (SELECT id FROM lb_entries WHERE ${where})`).bind(...args),
    db.prepare(`DELETE FROM lb_entries WHERE ${where}`).bind(...args),
    ...(game ? [] : [db.prepare('DELETE FROM lb_owners WHERE id = ?').bind(ownerId)]),
  ])
  return del.meta.changes ?? 0
}

export async function handleReport(req: Request, env: AppEnv): Promise<Response> {
  if (!originAllowed(req, env)) return reply(req, env, { error: 'forbidden' }, 403)
  const body = await readBody(req)
  const entryId = body?.entryId
  if (typeof entryId !== 'number' || !Number.isInteger(entryId) || entryId <= 0) return reply(req, env, { error: 'bad_request' }, 400)

  const now = Date.now()
  const who = await clientHash(req, env, now)
  if (await rateLimited(env.DB, `report:${who}`, REPORT_PER_MIN, 60_000, now)) return reply(req, env, { error: 'rate_limited' }, 429)

  const entry = await env.DB.prepare('SELECT id, owner_id, name_locked FROM lb_entries WHERE id = ?')
    .bind(entryId)
    .first<{ id: number; owner_id: string; name_locked: number }>()
  if (!entry) return reply(req, env, { error: 'not_found' }, 404)

  await env.DB.prepare('INSERT OR IGNORE INTO lb_reports (entry_id, reporter_hash, ts) VALUES (?, ?, ?)').bind(entryId, who, now).run()
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM lb_reports WHERE entry_id = ?').bind(entryId).first<{ n: number }>()
  // 신고가 쌓이면 관리자가 보기 전까지 중립 이름으로 바꿔 둔다 (삭제는 하지 않음)
  if ((count?.n ?? 0) >= REPORT_THRESHOLD && !entry.name_locked) {
    await env.DB.prepare("UPDATE lb_entries SET name = ?, name_status = 'reported', name_locked = 1 WHERE id = ?")
      .bind(await fallbackName(entry.owner_id), entryId)
      .run()
  }
  return reply(req, env, { ok: true })
}
