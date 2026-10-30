// /admin/api/lb/* — Access JWT 검사는 handleAdmin이 먼저 한다. 여기서는 쓰기 요청의 CSRF만 막는다.
import type { AppEnv } from '../env'
import { json } from '../util'
import { capOf } from './ai'
import { DEFAULT_GAME_BOUNDS, deleteOwnerEntries } from './api'
import { rescanPublishedNames } from './maintain'
import { cleanName, fallbackName, nameKey } from './moderation'

const NO_STORE = { 'Cache-Control': 'no-store' }
const ok = (data: unknown = { ok: true }) => json(data, { headers: NO_STORE })
const bad = (error: string, status = 400) => json({ error }, { status, headers: NO_STORE })

const FILTERS: Record<string, string> = {
  all: '1 = 1',
  reported: 'e.id IN (SELECT entry_id FROM lb_reports)',
  unchecked: "e.name_status = 'unchecked_ai'",
  renamed: "e.name_status NOT IN ('ok', 'unchecked_ai')",
  hidden: 'e.hidden = 1',
}

async function listEntries(db: D1Database, url: URL) {
  const where: string[] = [FILTERS[url.searchParams.get('filter') ?? 'all'] ?? FILTERS.all]
  const args: unknown[] = []
  const game = url.searchParams.get('game')
  if (game) {
    where.push('e.game = ?')
    args.push(game)
  }
  const q = url.searchParams.get('q')
  if (q) {
    where.push('e.name LIKE ?')
    args.push(`%${q.replace(/[%_]/g, '')}%`)
  }
  const { results } = await db
    .prepare(
      `SELECT e.id, e.game, e.owner_id, e.name, e.name_status, e.name_locked, e.score, e.stats, e.duration_ms, e.ts, e.updated_at, e.hidden,
              o.banned, (SELECT COUNT(*) FROM lb_reports r WHERE r.entry_id = e.id) AS reports
       FROM lb_entries e JOIN lb_owners o ON o.id = e.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY reports DESC, e.updated_at DESC LIMIT 200`,
    )
    .bind(...args)
    .all()
  return { entries: results }
}

async function usage(env: AppEnv, now: number) {
  const day = new Date(now).toISOString().slice(0, 10)
  const row = await env.DB.prepare('SELECT calls FROM lb_ai_usage WHERE day = ?').bind(day).first<{ calls: number }>()
  return { day, calls: row?.calls ?? 0, cap: capOf(env), enabled: !!env.AI && env.AI_MODERATION !== 'off', model: env.AI_MODEL ?? null }
}

type Body = Record<string, unknown>

async function entryOf(db: D1Database, b: Body) {
  if (typeof b.entryId !== 'number') return null
  return db.prepare('SELECT id, owner_id, name FROM lb_entries WHERE id = ?').bind(b.entryId).first<{ id: number; owner_id: string; name: string }>()
}

async function action(env: AppEnv, b: Body, now: number): Promise<Response> {
  const db = env.DB
  switch (b.action) {
    case 'hide':
    case 'unhide': {
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      await db.prepare('UPDATE lb_entries SET hidden = ? WHERE id = ?').bind(b.action === 'hide' ? 1 : 0, e.id).run()
      return ok()
    }
    case 'rename': {
      // 중립 이름으로 바꾸고 잠근다 (다음 제출의 닉네임을 쓰지 않음)
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      await db.prepare("UPDATE lb_entries SET name = ?, name_status = 'admin_renamed', name_locked = 1 WHERE id = ?")
        .bind(await fallbackName(e.owner_id), e.id)
        .run()
      return ok()
    }
    case 'unlock': {
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      await db.batch([
        db.prepare('UPDATE lb_entries SET name_locked = 0 WHERE id = ?').bind(e.id),
        db.prepare('DELETE FROM lb_reports WHERE entry_id = ?').bind(e.id),
      ])
      return ok()
    }
    case 'dismiss_reports': {
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      await db.prepare('DELETE FROM lb_reports WHERE entry_id = ?').bind(e.id).run()
      return ok()
    }
    case 'delete': {
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      await db.batch([db.prepare('DELETE FROM lb_reports WHERE entry_id = ?').bind(e.id), db.prepare('DELETE FROM lb_entries WHERE id = ?').bind(e.id)])
      return ok()
    }
    case 'delete_owner': {
      // 연락처로 들어온 삭제 요청: 그 플레이어의 모든 게임 기록과 토큰
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      return ok({ deleted: await deleteOwnerEntries(db, e.owner_id, null) })
    }
    case 'ban_owner':
    case 'unban_owner': {
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      const ban = b.action === 'ban_owner'
      await db.prepare('UPDATE lb_owners SET banned = ? WHERE id = ?').bind(ban ? 1 : 0, e.owner_id).run()
      if (ban) {
        await db.prepare("UPDATE lb_entries SET name = ?, name_status = 'banned_owner' WHERE owner_id = ?")
          .bind(await fallbackName(e.owner_id), e.owner_id)
          .run()
      }
      return ok()
    }
    case 'ban_name': {
      // 이 이름을 차단어로 추가하고, 같은 단어를 쓰는 공개 이름을 모두 바꾼다
      const e = await entryOf(db, b)
      if (!e) return bad('not_found', 404)
      const term = nameKey(e.name)
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO lb_terms (term, added_at) VALUES (?, ?)').bind(term, now),
        db.prepare("INSERT OR REPLACE INTO lb_names (name_key, verdict, checked_at) VALUES (?, 'unsafe', ?)").bind(term, now),
      ])
      return ok({ renamed: await rescanPublishedNames(db) })
    }
    case 'add_term':
    case 'remove_term': {
      const term = typeof b.term === 'string' ? cleanName(b.term).toLowerCase() : ''
      if (!term || term.length > 40) return bad('bad_term')
      if (b.action === 'remove_term') {
        await db.prepare('DELETE FROM lb_terms WHERE term = ?').bind(term).run()
        return ok()
      }
      await db.prepare('INSERT OR IGNORE INTO lb_terms (term, added_at) VALUES (?, ?)').bind(term, now).run()
      return ok({ renamed: await rescanPublishedNames(db) })
    }
    case 'update_game': {
      const slug = typeof b.slug === 'string' ? b.slug : ''
      const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
      let statMax: string | null = null
      if (b.stat_max != null) {
        if (typeof b.stat_max !== 'object' || Array.isArray(b.stat_max)) return bad('bad_stat_max')
        statMax = JSON.stringify(b.stat_max)
      }
      const res = await db
        .prepare('UPDATE lb_games SET max_score = ?, max_score_per_sec = ?, min_duration_ms = ?, stat_max = ?, enabled = ? WHERE slug = ?')
        .bind(
          num(b.max_score, DEFAULT_GAME_BOUNDS.max_score),
          num(b.max_score_per_sec, 0),
          Math.round(num(b.min_duration_ms, DEFAULT_GAME_BOUNDS.min_duration_ms)),
          statMax,
          b.enabled === false ? 0 : 1,
          slug,
        )
        .run()
      return res.meta.changes ? ok() : bad('not_found', 404)
    }
    default:
      return bad('unknown_action')
  }
}

/** /admin/api/lb/* 처리. 해당 경로가 아니면 null. */
export async function handleLbAdmin(req: Request, env: AppEnv, path: string, url: URL, now: number): Promise<Response | null> {
  if (!path.startsWith('/admin/api/lb/')) return null
  const db = env.DB
  if (req.method === 'GET') {
    if (path === '/admin/api/lb/entries') return ok(await listEntries(db, url))
    if (path === '/admin/api/lb/games') return ok({ games: (await db.prepare('SELECT * FROM lb_games ORDER BY slug').all()).results })
    if (path === '/admin/api/lb/terms') return ok({ terms: (await db.prepare('SELECT term, added_at FROM lb_terms ORDER BY added_at DESC').all()).results })
    if (path === '/admin/api/lb/usage') return ok(await usage(env, now))
  }
  if (req.method === 'POST' && path === '/admin/api/lb/action') {
    // 다른 사이트의 폼/fetch가 Access 쿠키로 쓰기 요청을 보내지 못하게: 사용자 정의 헤더는 preflight 없이 못 붙인다
    if (req.headers.get('X-Admin') !== '1') return bad('forbidden', 403)
    let b: unknown
    try {
      b = await req.json()
    } catch {
      return bad('bad_json')
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('bad_json')
    return action(env, b as Body, now)
  }
  return json({ error: 'not_found' }, { status: 404, headers: NO_STORE })
}
