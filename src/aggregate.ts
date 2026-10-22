import { DAY_MS, dayStartMs, kstDay } from './util'

export const RAW_RETENTION_DAYS = 90

const SOURCE_ALIASES: [RegExp, string][] = [
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'youtube'],
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)naver\.com$/, 'naver'],
  [/^t\.co$|(^|\.)x\.com$|(^|\.)twitter\.com$/, 'x'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)discord(app)?\.com$/, 'discord'],
  [/(^|\.)github\.com$/, 'github'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)tistory\.com$/, 'tistory'],
  [/(^|\.)blogspot\.com$|(^|\.)blogger\.com$/, 'blogger'],
  [/(^|\.)itch\.io$/, 'itch.io'],
]

/** utm_source 또는 referrer 도메인 → 공개용 소스 이름 */
export function sourceName(utm: string | null, host: string | null): string {
  if (utm) return utm
  if (!host) return 'direct'
  for (const [re, name] of SOURCE_ALIASES) if (re.test(host)) return name
  return host
}

/** 하루(KST) 치 raw events → daily_stats. 같은 날을 다시 돌리면 덮어쓴다(멱등). */
export async function aggregateDay(db: D1Database, day: string): Promise<Record<string, number>> {
  const from = dayStartMs(day)
  const to = from + DAY_MS
  const range = (sql: string) => db.prepare(sql).bind(from, to)

  const [totals, pages, games, sources] = await db.batch([
    range(
      `SELECT SUM(type = 'pageview') AS pageviews,
              COUNT(DISTINCT CASE WHEN type IN ('pageview', 'game_start') THEN visitor_hash END) AS visitors
       FROM events WHERE ts >= ? AND ts < ?`,
    ),
    range(
      `SELECT path, COUNT(*) AS n FROM events
       WHERE type = 'pageview' AND ts >= ? AND ts < ? GROUP BY path`,
    ),
    range(
      `SELECT game,
              SUM(type = 'game_start') AS plays,
              SUM(type = 'game_over') AS runs,
              MAX(CASE WHEN type IN ('stage_clear', 'game_over') THEN CAST(json_extract(props, '$.score') AS REAL) END) AS best
       FROM events WHERE game IS NOT NULL AND ts >= ? AND ts < ? GROUP BY game`,
    ),
    range(
      `SELECT utm_source, referrer_host, COUNT(*) AS n FROM events
       WHERE type = 'pageview' AND json_extract(props, '$.entry') = 1 AND ts >= ? AND ts < ?
       GROUP BY utm_source, referrer_host`,
    ),
  ])

  const metrics: Record<string, number> = {}
  const t = (totals.results[0] ?? {}) as { pageviews: number | null; visitors: number | null }
  metrics.pageviews = t.pageviews ?? 0
  metrics.visitors = t.visitors ?? 0
  for (const r of pages.results as { path: string; n: number }[]) metrics[`page:${r.path}`] = r.n
  for (const r of games.results as { game: string; plays: number; runs: number; best: number | null }[]) {
    metrics[`plays:${r.game}`] = r.plays
    metrics[`runs:${r.game}`] = r.runs
    if (r.best != null) metrics[`best:${r.game}`] = r.best
  }
  for (const r of sources.results as { utm_source: string | null; referrer_host: string | null; n: number }[]) {
    const key = `source:${sourceName(r.utm_source, r.referrer_host)}`
    metrics[key] = (metrics[key] ?? 0) + r.n
  }

  const insert = db.prepare('INSERT INTO daily_stats (day, metric, value) VALUES (?, ?, ?)')
  await db.batch([
    db.prepare('DELETE FROM daily_stats WHERE day = ?').bind(day),
    ...Object.entries(metrics).map(([m, v]) => insert.bind(day, m, v)),
  ])
  return metrics
}

/** Cron(00:10 KST): 전날 집계, 90일 지난 raw 삭제, 이틀 지난 솔트 삭제 */
export async function runDailyCron(db: D1Database, now: number): Promise<void> {
  const today = kstDay(now)
  await aggregateDay(db, kstDay(now - DAY_MS))
  await db.batch([
    db.prepare('DELETE FROM events WHERE ts < ?').bind(now - RAW_RETENTION_DAYS * DAY_MS),
    db.prepare('DELETE FROM salts WHERE day < ?').bind(kstDay(dayStartMs(today) - DAY_MS)),
  ])
}
