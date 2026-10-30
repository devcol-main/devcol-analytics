# devcol-analytics

Cookie-free analytics for [devcol.net](https://devcol.net) and its web games. A single Cloudflare Worker with a D1 database, inside the free tier.

- `POST /e` collects events from the site script (`/t.js`)
- `GET /public/summary` serves aggregated totals for [devcol.net/stats](https://devcol.net/stats)
- `/lb/*` is the shared online leaderboard for the games (no login)
- `GET /admin` is the private dashboard (behind Cloudflare Access)

No cookies, no raw IP addresses or user-agent strings stored, nothing sent when the browser has Do Not Track or Global Privacy Control on. Visitors are counted per day with a hash of IP + user-agent + a salt that changes daily and is deleted after two days.

## Layout

```
src/
  index.ts      router (fetch) + daily cron (scheduled)
  collect.ts    POST /e: validation, server-side fields, visitor hash, insert
  bot.ts        origin / bot UA / size / payload / rate-limit filters
  aggregate.ts  daily rollup into daily_stats, 90-day retention, salt cleanup
  public.ts     GET /public/summary (reads daily_stats only, counts under 5 → "<5")
  admin.ts      Cloudflare Access JWT check + /admin and /admin/api/*
  admin.html    dashboard (Chart.js from cdnjs)
  lb/
    api.ts        /lb/submit, /lb/top, /lb/delete, /lb/report: owner tokens, bounds, rate limits
    moderation.ts nickname format + normalization + blocklist (pure functions)
    blocklist.ts  built-in Korean + English terms and allowlist
    ai.ts         Workers AI name check with a hard daily cap
    maintain.ts   cron: retention, re-check of names the AI skipped, rescan after new terms
    admin.ts      /admin/api/lb/*
client/t.js     site script source (minified into devcol-site by npm run build:client)
migrations/     D1 schema
test/           vitest in the Workers runtime (@cloudflare/vitest-plugin)
```

## Endpoints

| Method | Path | Access |
|---|---|---|
| POST | `/e` | public, Origin must be devcol.net / www.devcol.net |
| GET | `/public/summary` | public, CORS for devcol.net, cached 1 h |
| GET | `/admin` | Cloudflare Access + JWT check in the Worker |
| GET | `/admin/api/site?days=7\|30\|90` | same |
| GET | `/admin/api/games?days=7\|30\|90` | same |
| GET | `/admin/api/realtime` | same |
| POST | `/admin/api/aggregate?day=YYYY-MM-DD` | same (default: today, KST) |
| POST | `/lb/submit` | public, Origin must be devcol.net / www.devcol.net |
| GET | `/lb/top?game=<slug>&n=10` | public, CORS for devcol.net (n ≤ 50) |
| POST | `/lb/delete` | public, needs the owner token |
| POST | `/lb/report` | public, Origin checked |
| GET | `/admin/api/lb/entries?filter=all\|reported\|unchecked\|renamed\|hidden&game=&q=` | Access |
| GET | `/admin/api/lb/games`, `/terms`, `/usage` | Access |
| POST | `/admin/api/lb/action` | Access + `X-Admin: 1` header |

Event types: `pageview`, `page_leave`, `game_start`, `stage_clear`, `game_over`, `custom`. Anything under `/games/<slug>/` is tagged with `game = <slug>` automatically; there is no list of games in the code. To hook up a new game, follow `docs/GAME-ANALYTICS.md` in devcol-site.

## Online leaderboard

No accounts. The first submit from a browser gets a random owner token back (once); the game keeps it in `localStorage` (`devcol.player.token`) and sends it with later submits. The server stores only its SHA-256. With the token a player can delete their own entries (`POST /lb/delete {token, game?}`; without `game` the token is deleted too). Without it, the admin deletes on request from the Contact page.

Bodies are JSON sent as `text/plain` (no CORS preflight), like `/e`:

```
POST /lb/submit  {"game":"stack-up","name":"Kim","score":120,"stats":{"stage":4},"durationMs":61000,"token":"<64 hex, optional>"}
→ {"entryId":12,"publishedName":"Kim","nameStatus":"ok","best":120,"rank":3,"token":"<only on the first submit>"}
POST /lb/delete  {"token":"…","game":"stack-up"}   → {"deleted":1}   (404 for an unknown token)
POST /lb/report  {"entryId":12}                      → {"ok":true}
GET  /lb/top?game=stack-up&n=10                      → {"game":"stack-up","entries":[{"id","name","score","stats","ts"}]}
```

One row per player per game (their best score). Games are not listed in the code: an unknown slug is registered on its first submit if `SITE_ORIGIN/games/<slug>/` answers 200, with loose default bounds that the admin can tighten (max score, max score per second, minimum duration, per-stat max).

Nickname moderation, in order: format (2–12 letters, Hangul syllables or digits, single spaces) → blocklist after normalization (NFKC, case, spacing, leet digits, repeated letters, Korean 된소리/vowel variants) plus admin terms → Workers AI, once per distinct name (cached in `lb_names`). A name that fails is published as `Player####` (stable per player); the typed name is not stored. Three reports from different people rename an entry to `Player####` until the admin looks at it.

Workers AI cost guard: the Worker counts AI calls per UTC day in D1 and stops at `AI_DAILY_CAP` before calling. Over the cap, on errors or after 2.5 s the name is published on the rules alone as `unchecked_ai`, and the daily cron re-checks those names later. On the Workers Free plan Workers AI is capped at 10,000 Neurons/day and is never billed; one check costs about 0.7 Neurons with the default model.

Retention: entries and tokens are deleted 365 days after the player's last submit, reports after 90 days. Rate limits (per daily-salted IP hash, nothing raw stored): 10 submits/min, 5 reports/min, 3 new tokens/hour.

The admin dashboard has a Leaderboard tab: filter entries, hide, rename, ban a name or a player, delete, extra blocked terms, per-game bounds and today's AI usage.

## Development

```bash
npm ci
npm run check                 # tsc + vitest
npm run db:migrate:local
npx wrangler dev --var ALLOW_LOCALHOST:true   # accepts localhost origins
```

To try the client against the local Worker, load the script with an endpoint override:

```html
<script defer src="/t.js" data-endpoint="http://localhost:8787/e"></script>
```

Client script: edit `client/t.js`, then `npm run build:client` writes the minified file to `../devcol-site/devcol-build/docs/public/t.js` (override with `SITE_DIR=...`). It fails if the result is 2 KB or more.

## Deploy

```bash
npm run db:migrate:remote     # when there is a new migration
npm run deploy
```

The Worker is served on the custom domain `a.devcol.net` (set in `wrangler.toml`). The cron runs daily at 15:10 UTC (00:10 KST): it aggregates the previous KST day, deletes raw events older than 90 days and salts older than two days, and runs the leaderboard cleanup and AI re-check.

## Secrets

Nothing secret is in this repository. Set these with `wrangler secret put <NAME>`:

| Name | What |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Cloudflare Zero Trust team domain, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | Application Audience (AUD) tag of the Access application for `a.devcol.net/admin*` |

Until both are set, every `/admin` request gets 403, even if it passed Cloudflare Access.

Plain variables in `wrangler.toml`: `ALLOWED_ORIGINS`, `ALLOW_LOCALHOST` (`"false"` in production), and for the leaderboard `AI_MODERATION` (`"off"` = rules only), `AI_MODEL`, `AI_DAILY_CAP`, `SITE_ORIGIN`. The `[ai]` binding is not connected in tests (`remoteBindings: false` in `vitest.config.ts`); tests use a fake from `test/helpers.ts`.
