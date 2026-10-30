// 리더보드 정리 (daily cron에서 호출): 보관기간, AI 미검사 이름 재검사, rate/usage 기록 정리
import type { AppEnv } from '../env'
import { DAY_MS } from '../util'
import { aiCheckName } from './ai'
import { fallbackName, hitsBlocklist, nameKey } from './moderation'

/** 마지막 제출 후 이 기간이 지나면 기록과 owner(토큰)를 지운다 */
export const LB_RETENTION_DAYS = 365
export const REPORT_RETENTION_DAYS = 90
export const RECHECK_PER_RUN = 50

export async function cleanupLeaderboard(db: D1Database, now: number): Promise<void> {
  const cutoff = now - LB_RETENTION_DAYS * DAY_MS
  await db.batch([
    db.prepare('DELETE FROM lb_reports WHERE entry_id IN (SELECT id FROM lb_entries WHERE updated_at < ?)').bind(cutoff),
    db.prepare('DELETE FROM lb_entries WHERE updated_at < ?').bind(cutoff),
    db.prepare('DELETE FROM lb_owners WHERE last_seen < ? AND id NOT IN (SELECT owner_id FROM lb_entries)').bind(cutoff),
    db.prepare('DELETE FROM lb_reports WHERE ts < ?').bind(now - REPORT_RETENTION_DAYS * DAY_MS),
    db.prepare('DELETE FROM lb_rate WHERE ts < ?').bind(now - 3600_000),
    db.prepare('DELETE FROM lb_ai_usage WHERE day < ?').bind(new Date(now - 7 * DAY_MS).toISOString().slice(0, 10)),
  ])
}

/** AI 상한/오류로 규칙만 보고 공개한 이름을 다시 AI로 본다. 걸리면 Player####로 바꾼다. */
export async function recheckUnchecked(env: AppEnv, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, owner_id, name FROM lb_entries WHERE name_status = 'unchecked_ai' ORDER BY updated_at DESC LIMIT ?",
  )
    .bind(RECHECK_PER_RUN)
    .all<{ id: number; owner_id: string; name: string }>()
  let checked = 0
  for (const e of results) {
    const key = nameKey(e.name)
    const cached = await env.DB.prepare('SELECT verdict FROM lb_names WHERE name_key = ?').bind(key).first<{ verdict: string }>()
    let verdict = cached?.verdict
    if (!verdict) {
      const ai = await aiCheckName(env, e.name, now)
      if (ai === 'unknown') break // 상한/장애: 다음 날 다시
      verdict = ai
      await env.DB.prepare('INSERT OR REPLACE INTO lb_names (name_key, verdict, checked_at) VALUES (?, ?, ?)').bind(key, ai, now).run()
    }
    if (verdict === 'unsafe') {
      await env.DB.prepare("UPDATE lb_entries SET name = ?, name_status = 'ai_fallback' WHERE id = ?").bind(await fallbackName(e.owner_id), e.id).run()
    } else {
      await env.DB.prepare("UPDATE lb_entries SET name_status = 'ok' WHERE id = ?").bind(e.id).run()
    }
    checked++
  }
  return checked
}

/** 차단어가 늘었을 때 이미 공개된 이름을 다시 본다. 바뀐 개수를 돌려준다. */
export async function rescanPublishedNames(db: D1Database): Promise<number> {
  const terms = (await db.prepare('SELECT term FROM lb_terms').all<{ term: string }>()).results.map((r) => r.term)
  const { results } = await db
    .prepare("SELECT id, owner_id, name FROM lb_entries WHERE name_status IN ('ok', 'unchecked_ai')")
    .all<{ id: number; owner_id: string; name: string }>()
  let changed = 0
  for (const e of results) {
    if (!hitsBlocklist(e.name, terms)) continue
    await db.prepare("UPDATE lb_entries SET name = ?, name_status = 'admin_renamed' WHERE id = ?").bind(await fallbackName(e.owner_id), e.id).run()
    changed++
  }
  return changed
}

export async function runLeaderboardCron(env: AppEnv, now: number): Promise<void> {
  await cleanupLeaderboard(env.DB, now)
  await recheckUnchecked(env, now)
}
