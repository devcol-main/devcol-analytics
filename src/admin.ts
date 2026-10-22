import type { AppEnv } from './env'
import { aggregateDay } from './aggregate'
import { DAY_MS, isDay, json, kstDay } from './util'
import adminHtml from './admin.html'

// ---------- Cloudflare Access JWT 검증 (Access 설정 누락 시 이중 방어) ----------

interface Jwk extends JsonWebKey {
  kid: string
}
let jwksCache: { team: string; keys: Jwk[]; at: number } | null = null

/** 테스트 전용: 인증서 목록을 주입한다 */
export function __setJwksForTest(team: string, keys: Jwk[]) {
  jwksCache = { team, keys, at: Date.now() }
}

async function getJwks(team: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.team === team && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`certs ${res.status}`)
  const { keys } = (await res.json()) as { keys: Jwk[] }
  jwksCache = { team, keys, at: Date.now() }
  return keys
}

const b64urlDecode = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export async function verifyAccessJwt(token: string, env: AppEnv, now = Date.now()): Promise<boolean> {
  const team = env.ACCESS_TEAM_DOMAIN
  const aud = env.ACCESS_AUD
  if (!team || !aud) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { alg?: string; kid?: string }
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as {
      aud?: string | string[]
      exp?: number
      nbf?: number
      iss?: string
    }
    if (header.alg !== 'RS256' || !header.kid) return false
    const jwk = (await getJwks(team)).find((k) => k.kid === header.kid)
    if (!jwk) return false
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
    if (!ok) return false
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!auds.includes(aud)) return false
    if (payload.iss !== `https://${team}`) return false
    const sec = now / 1000
    if (typeof payload.exp !== 'number' || payload.exp < sec) return false
    if (typeof payload.nbf === 'number' && payload.nbf > sec + 60) return false
    return true
  } catch {
    return false
  }
}

// ---------- 대시보드 쿼리 ----------

const NO_STORE = { 'Cache-Control': 'no-store' }

function daysParam(url: URL): number {
  const d = Number(url.searchParams.get('days'))
  return [7, 30, 90].includes(d) ? d : 30
}

const KST_DAY_SQL = `date(ts / 1000 + 32400, 'unixepoch')`

async function siteStats(db: D1Database, since: number) {
  const q = (sql: string) => db.prepare(sql).bind(since)
  const [daily, pages, refs, utms, countries, devices, browsers, engagement] = await db.batch([
    q(`SELECT ${KST_DAY_SQL} AS day, SUM(type = 'pageview') AS pv,
              COUNT(DISTINCT CASE WHEN type IN ('pageview', 'game_start') THEN visitor_hash END) AS uv
       FROM events WHERE ts >= ? GROUP BY day ORDER BY day`),
    q(`SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors FROM events
       WHERE type = 'pageview' AND ts >= ? GROUP BY path ORDER BY views DESC LIMIT 20`),
    q(`SELECT referrer_host AS k, COUNT(*) AS n FROM events
       WHERE type = 'pageview' AND referrer_host IS NOT NULL AND ts >= ? GROUP BY k ORDER BY n DESC LIMIT 20`),
    q(`SELECT utm_source AS k, COUNT(*) AS n FROM events
       WHERE type = 'pageview' AND utm_source IS NOT NULL AND ts >= ? GROUP BY k ORDER BY n DESC LIMIT 20`),
    q(`SELECT COALESCE(country, '??') AS k, COUNT(*) AS n FROM events
       WHERE type = 'pageview' AND ts >= ? GROUP BY k ORDER BY n DESC LIMIT 20`),
    q(`SELECT device AS k, COUNT(*) AS n FROM events WHERE type = 'pageview' AND ts >= ? GROUP BY k ORDER BY n DESC`),
    q(`SELECT browser AS k, COUNT(*) AS n FROM events WHERE type = 'pageview' AND ts >= ? GROUP BY k ORDER BY n DESC`),
    q(`SELECT path, COUNT(*) AS n,
              AVG(json_extract(props, '$.duration_ms')) AS avg_ms,
              AVG(json_extract(props, '$.scroll_pct')) AS avg_scroll
       FROM events WHERE type = 'page_leave' AND game IS NULL AND ts >= ?
       GROUP BY path ORDER BY n DESC LIMIT 30`),
  ])
  return {
    daily: daily.results,
    top_pages: pages.results,
    referrers: refs.results,
    utm_sources: utms.results,
    countries: countries.results,
    devices: devices.results,
    browsers: browsers.results,
    engagement: engagement.results,
  }
}

const HIST_BUCKETS = 10

export function histogram(scores: number[]) {
  if (!scores.length) return []
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const width = Math.max(1, Math.ceil((max - min + 1) / HIST_BUCKETS))
  const buckets = Array.from({ length: HIST_BUCKETS }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width - 1, n: 0 }))
  for (const s of scores) buckets[Math.min(HIST_BUCKETS - 1, Math.floor((s - min) / width))].n++
  while (buckets.length && buckets[buckets.length - 1].n === 0) buckets.pop()
  return buckets
}

async function gameStats(db: D1Database, since: number) {
  const q = (sql: string) => db.prepare(sql).bind(since)
  const [summary, finals, clears, scores] = await db.batch([
    q(`SELECT game,
              SUM(type = 'game_start') AS opens,
              SUM(type = 'game_over') AS runs,
              COUNT(DISTINCT session_id) AS sessions,
              AVG(CASE WHEN type = 'game_over' THEN json_extract(props, '$.duration_ms') END) AS avg_run_ms,
              AVG(CASE WHEN type = 'page_leave' THEN json_extract(props, '$.duration_ms') END) AS avg_session_ms,
              MAX(CASE WHEN type IN ('stage_clear', 'game_over') THEN CAST(json_extract(props, '$.score') AS REAL) END) AS best
       FROM events WHERE game IS NOT NULL AND ts >= ? GROUP BY game ORDER BY opens DESC`),
    // 퍼널: 게임오버 시점의 스테이지 분포 → 스테이지별 도달/이탈
    q(`SELECT game, CAST(json_extract(props, '$.stage') AS INTEGER) AS stage, COUNT(*) AS n FROM events
       WHERE type = 'game_over' AND game IS NOT NULL AND ts >= ? GROUP BY game, stage ORDER BY game, stage`),
    q(`SELECT game, CAST(json_extract(props, '$.stage') AS INTEGER) AS stage, COUNT(*) AS n FROM events
       WHERE type = 'stage_clear' AND game IS NOT NULL AND ts >= ? GROUP BY game, stage ORDER BY game, stage`),
    q(`SELECT game, CAST(json_extract(props, '$.score') AS REAL) AS score FROM events
       WHERE type = 'game_over' AND game IS NOT NULL AND json_extract(props, '$.score') IS NOT NULL AND ts >= ?
       ORDER BY ts DESC LIMIT 5000`),
  ])

  const games: Record<string, unknown>[] = []
  for (const g of summary.results as { game: string }[]) {
    const fin = (finals.results as { game: string; stage: number | null; n: number }[]).filter((r) => r.game === g.game && r.stage != null)
    const totalRuns = fin.reduce((a, r) => a + r.n, 0)
    let remaining = totalRuns
    const funnel = fin.map((r) => {
      const row = { stage: r.stage, reached: remaining, dropped: r.n }
      remaining -= r.n
      return row
    })
    games.push({
      ...g,
      funnel,
      stage_clears: (clears.results as { game: string; stage: number; n: number }[])
        .filter((r) => r.game === g.game)
        .map(({ stage, n }) => ({ stage, n })),
      score_histogram: histogram((scores.results as { game: string; score: number }[]).filter((r) => r.game === g.game).map((r) => r.score)),
    })
  }
  return { games }
}

async function realtime(db: D1Database, now: number) {
  const [recent, byType, current] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM events WHERE ts >= ?').bind(now - 30 * 60_000),
    db.prepare('SELECT type, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY type ORDER BY n DESC').bind(now - 30 * 60_000),
    // 세션마다 최근 5분 내 마지막 이벤트. 그게 page_leave가 아니면 아직 보고 있는 것으로 본다.
    db
      .prepare(
        `SELECT path, COUNT(*) AS viewers FROM (
           SELECT session_id, path, type, MAX(ts) FROM events WHERE ts >= ? GROUP BY session_id
         ) WHERE type != 'page_leave' GROUP BY path ORDER BY viewers DESC`,
      )
      .bind(now - 5 * 60_000),
  ])
  return {
    events_30m: (recent.results[0] as { n: number }).n,
    by_type_30m: byType.results,
    current_pages: current.results,
  }
}

export async function handleAdmin(req: Request, env: AppEnv): Promise<Response> {
  const token = req.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !(await verifyAccessJwt(token, env))) {
    return new Response('Forbidden', { status: 403, headers: NO_STORE })
  }

  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '')
  const now = Date.now()

  if (path === '/admin' && req.method === 'GET') {
    return new Response(adminHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } })
  }
  if (path === '/admin/api/site' && req.method === 'GET') {
    return json(await siteStats(env.DB, now - daysParam(url) * DAY_MS), { headers: NO_STORE })
  }
  if (path === '/admin/api/games' && req.method === 'GET') {
    return json(await gameStats(env.DB, now - daysParam(url) * DAY_MS), { headers: NO_STORE })
  }
  if (path === '/admin/api/realtime' && req.method === 'GET') {
    return json(await realtime(env.DB, now), { headers: NO_STORE })
  }
  // 집계 수동 트리거 (스모크 테스트/백필용). 기본값은 오늘(KST).
  if (path === '/admin/api/aggregate' && req.method === 'POST') {
    const day = url.searchParams.get('day') ?? kstDay(now)
    if (!isDay(day)) return json({ error: 'day must be YYYY-MM-DD' }, { status: 400, headers: NO_STORE })
    return json({ day, metrics: await aggregateDay(env.DB, day) }, { headers: NO_STORE })
  }
  return new Response('Not found', { status: 404, headers: NO_STORE })
}
