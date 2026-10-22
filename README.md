# devcol-analytics

Cookie-free analytics for [devcol.net](https://devcol.net) and its web games. A single Cloudflare Worker with a D1 database, inside the free tier.

- `POST /e` collects events from the site script (`/t.js`)
- `GET /public/summary` serves aggregated totals for [devcol.net/stats](https://devcol.net/stats)
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

Event types: `pageview`, `page_leave`, `game_start`, `stage_clear`, `game_over`, `custom`. Anything under `/games/<slug>/` is tagged with `game = <slug>` automatically; there is no list of games in the code. To hook up a new game, follow `docs/GAME-ANALYTICS.md` in devcol-site.

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

The Worker is served on the custom domain `a.devcol.net` (set in `wrangler.toml`). The cron runs daily at 15:10 UTC (00:10 KST): it aggregates the previous KST day, deletes raw events older than 90 days and salts older than two days.

## Secrets

Nothing secret is in this repository. Set these with `wrangler secret put <NAME>`:

| Name | What |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Cloudflare Zero Trust team domain, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | Application Audience (AUD) tag of the Access application for `a.devcol.net/admin*` |

Until both are set, every `/admin` request gets 403, even if it passed Cloudflare Access.

Plain variables in `wrangler.toml`: `ALLOWED_ORIGINS`, `ALLOW_LOCALHOST` (`"false"` in production).
