import type { AppEnv } from './env'
import { addDays, json, matchOrigin } from './util'

/** 소수 방문 노출 방지: 5 미만은 "<5" */
export const mask = (n: number): number | '<5' => (n < 5 ? '<5' : Math.round(n))

const TOP_POSTS = 5
const TOP_SOURCES = 6

/** 공개 요약. daily_stats(집계 결과)만 읽고 raw events는 읽지 않는다. */
export async function buildSummary(db: D1Database) {
  const range = await db.prepare('SELECT MIN(day) AS since, MAX(day) AS updated FROM daily_stats').first<{
    since: string | null
    updated: string | null
  }>()
  const updated = range?.updated ?? null
  const since = range?.since ?? null
  const from = updated ? addDays(updated, -29) : '0000-00-00'

  const [totals, posts, titles, games, sources] = await db.batch([
    db
      .prepare(
        `SELECT SUM(CASE WHEN metric = 'pageviews' THEN value ELSE 0 END) AS pv,
                SUM(CASE WHEN metric = 'visitors' THEN value ELSE 0 END) AS uv
         FROM daily_stats WHERE day >= ?`,
      )
      .bind(from),
    db
      .prepare(
        `SELECT substr(metric, 6) AS path, SUM(value) AS views FROM daily_stats
         WHERE day >= ? AND metric LIKE 'page:/blog/_%' GROUP BY metric ORDER BY views DESC LIMIT ?`,
      )
      .bind(from, TOP_POSTS),
    // 제목은 클라이언트가 보낸 document.title (최근 값). raw가 90일 지나 지워졌으면 null.
    db.prepare(
      `SELECT path, json_extract(props, '$.title') AS title, MAX(ts) FROM events
       WHERE type = 'pageview' AND path LIKE '/blog/_%' AND json_extract(props, '$.title') IS NOT NULL GROUP BY path`,
    ),
    db.prepare(
      `SELECT substr(metric, instr(metric, ':') + 1) AS game,
              SUM(CASE WHEN metric LIKE 'plays:%' THEN value ELSE 0 END) AS plays,
              MAX(CASE WHEN metric LIKE 'best:%' THEN value END) AS best
       FROM daily_stats WHERE metric LIKE 'plays:%' OR metric LIKE 'best:%'
       GROUP BY game ORDER BY plays DESC`,
    ),
    db
      .prepare(
        `SELECT substr(metric, 8) AS source, SUM(value) AS n FROM daily_stats
         WHERE day >= ? AND metric LIKE 'source:%' GROUP BY metric ORDER BY n DESC`,
      )
      .bind(from),
  ])

  const t = (totals.results[0] ?? {}) as { pv: number | null; uv: number | null }
  const titleOf = new Map((titles.results as { path: string; title: string }[]).map((r) => [r.path, r.title]))

  // 5건 미만 소스는 개별 노출하지 않고 other로 합친다
  const srcRows = sources.results as { source: string; n: number }[]
  const srcTotal = srcRows.reduce((a, r) => a + r.n, 0)
  const shown = srcRows.filter((r) => r.n >= 5).slice(0, TOP_SOURCES)
  const rest = srcTotal - shown.reduce((a, r) => a + r.n, 0)
  const top_sources_30d = srcTotal
    ? [...shown.map((r) => ({ source: r.source, share: r.n / srcTotal })), ...(rest > 0 ? [{ source: 'other', share: rest / srcTotal }] : [])].map(
        (r) => ({ source: r.source, share: Math.round(r.share * 100) / 100 }),
      )
    : []

  return {
    updated,
    since,
    pageviews_30d: mask(t.pv ?? 0),
    visitors_30d: mask(t.uv ?? 0),
    top_posts_30d: (posts.results as { path: string; views: number }[]).map((r) => ({
      path: r.path,
      title: titleOf.get(r.path) ?? null,
      views: mask(r.views),
    })),
    games: (games.results as { game: string; plays: number; best: number | null }[]).map((r) => ({
      game: r.game,
      plays_total: mask(r.plays),
      best_score: r.best ?? 0,
    })),
    top_sources_30d,
  }
}

export async function handlePublicSummary(req: Request, env: AppEnv): Promise<Response> {
  const origin = matchOrigin(req.headers.get('Origin'), env)
  const headers: Record<string, string> = { 'Cache-Control': 'public, max-age=3600', Vary: 'Origin' }
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  return json(await buildSummary(env.DB), { headers })
}
