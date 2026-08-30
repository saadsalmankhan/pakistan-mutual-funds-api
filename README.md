# Pakistan Mutual Funds API

A small self-hosted scraper + REST API for Pakistani mutual fund NAVs (net
asset values), sourced from [MUFAP's](https://www.mufap.com.pk/) public Fund
Directory. Run it yourself, point your frontend at it, done.

Don't want to run anything? This scraper also feeds
[pakistan-mutual-funds-data](https://github.com/saadsalmankhan/pakistan-mutual-funds-data),
a free public dataset where a GitHub Action commits the daily snapshot,
growing NAV history and fund metadata every business day — just fetch the
raw files.

## Why this exists

MUFAP's own JSON endpoints (the ones their site's own JS calls) reject
server-side requests even with browser-identical headers — they likely
require some session/anti-forgery state that isn't practical to replicate
outside a real browser. Their public Fund Directory page, on the other hand,
is a plain server-rendered HTML table with every fund's current NAV already
in the markup — no auth, no pagination, ~500+ funds in one response — so
this scrapes that page instead of fighting the broken API.

## Quickstart

```bash
git clone https://github.com/saadsalmankhan/pakistan-mutual-funds-api.git
cd pakistan-mutual-funds-api
npm install
cp .env.example .env
npm run dev
```

The server starts on `http://localhost:4000` (configurable), scrapes MUFAP
once immediately on startup, and serves whatever it has at `GET /api/funds`.

## How it works

- **Scraper** (`src/scraper.ts`) fetches and parses MUFAP's Fund Directory
  page with [cheerio](https://cheerio.js.org/).
- **Cloudflare handling** — MUFAP sits behind Cloudflare's bot protection, so
  a plain request gets a `403`. The scraper uses
  [got-scraping](https://github.com/apify/got-scraping) to fetch the page with
  a real browser's TLS fingerprint, which Cloudflare serves the real page to.
  This is automatic: no clearance cookies, no headless browser and no config,
  so a fresh clone works out of the box. Cloudflare still challenges the odd
  request, so the fetch retries a few times before giving up.
- **Storage** (`src/store.ts`) writes the result to a local JSON file
  (`./data/funds.json` by default) — no database required.
- **History** — every successful scrape also appends each fund's NAV to a
  per-fund NDJSON file under `./data/history/`, one entry per day, so an
  instance accumulates a NAV time series from the day it starts running.
  MUFAP doesn't publish a NAV date on the directory page, so entries are
  keyed by the scrape date in MUFAP's timezone (Asia/Karachi); a re-scrape
  on the same date replaces that day's entry if MUFAP corrected the values.
- **Scheduler** (`src/scheduler.ts`) re-scrapes on a configurable interval.
  MUFAP only publishes updated NAVs once per business day, so scraping more
  often than that just makes extra requests against their site for no new
  data — the default (`FETCH_TIMES_PER_DAY=1`) reflects that.
- **API** (`src/server.ts`) is a minimal Express server exposing the current
  cached data, with CORS wide open so you can call it directly from
  frontend JS.
- **Enrichment** (`src/enrich.ts`, `npm run enrich`) scrapes MUFAP's
  server-rendered Expense Ratios table (Industry Statistics) and stores
  per-fund TER, management fee and inception date in `data/meta.json`;
  every subsequent snapshot merges it in by `fundId`. Expense ratios change
  rarely, so running it daily is fine but weekly is plenty.

## Configuration

All via environment variables (see `.env.example`):

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port the API server listens on |
| `FETCH_TIMES_PER_DAY` | `1` | How often the built-in scheduler re-scrapes. Set to `0` to disable it entirely (see below) |
| `SKIP_WEEKENDS` | `true` | Skip scheduled fetches on Sat/Sun — MUFAP doesn't publish new NAVs on weekends |
| `DATA_FILE` | `./data/funds.json` | Where scraped data is stored on disk |
| `HISTORY_DIR` | `./data/history` | Where per-fund NAV history (NDJSON) accumulates |
| `META_FILE` | `./data/meta.json` | Where `npm run enrich` stores expense ratios and inception dates |
| `SCRAPE_ATTEMPTS` | `4` | How many times to retry the MUFAP fetch past an occasional Cloudflare challenge |
| `SCRAPE_TIMEOUT_MS` | `45000` | Per-request timeout for the MUFAP fetch, in milliseconds |

## Running it your way

Two ways to keep the data fresh, pick whichever fits your setup:

1. **Built-in scheduler** (default) — `npm start` runs the API server and
   an in-process scheduler together. Simplest option if you're running this
   as a long-lived process (a VM, a container, etc.).
2. **Your own cron** — set `FETCH_TIMES_PER_DAY=0` to disable the built-in
   scheduler, and instead run `npm run scrape` on whatever schedule you
   want (system cron, GitHub Actions, Vercel Cron, a serverless scheduled
   function...). Useful if you're deploying the API server somewhere
   serverless/ephemeral where a long-running `setInterval` doesn't make
   sense — trigger the scrape externally, the API just serves whatever's
   on disk.

## API reference

### `GET /api/funds`

Returns every fund currently cached. Optional filters, all case-insensitive:

| Param | Matches |
|---|---|
| `category` | Fund category, exact (`?category=money%20market`) |
| `amc` | Asset Management Company, exact |
| `q` | Substring of the fund name (`?q=abl%20cash`) |
| `shariah` | `true` or `false` — Shariah-compliant funds only, or conventional only |

```bash
curl http://localhost:4000/api/funds
```

```json
{
  "funds": [
    {
      "fundId": "12768",
      "name": "ABL Cash Fund",
      "amc": "ABL Asset Management Company Limited",
      "nav": 10.32,
      "offerPrice": 10.41,
      "category": "Money Market",
      "shariah": false,
      "benchmark": null,
      "inceptionDate": "Jul 31, 2010",
      "expenseRatio": 1.15,
      "managementFee": 0.7
    }
  ],
  "updatedAt": "2026-07-17T21:22:35.027Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `fundId` | `string` | MUFAP's internal fund ID (falls back to the fund name if MUFAP's markup doesn't expose one) |
| `name` | `string` | Fund name |
| `amc` | `string` | Asset Management Company that runs the fund |
| `nav` | `number` | Current net asset value per unit (PKR) |
| `offerPrice` | `number` | Current offer price per unit (PKR) |
| `category` | `string` | Fund category, e.g. "Money Market", "Equity" |
| `shariah` | `boolean` | Whether the fund is Shariah-compliant (derived from MUFAP's category) |
| `benchmark` | `string \| null` | `"KSE-100"` for conventional equity categories, `"KMI-30"` for Shariah equity categories, `null` for everything else (mixed-mandate and fixed-income funds have no single honest index) |
| `inceptionDate` | `string?` | Fund inception date as MUFAP prints it (needs `npm run enrich`) |
| `expenseRatio` | `number?` | Total Expense Ratio, YTD % — fiscal year-to-date (Pakistani fiscal year starts July 1), so values reset each July and look small or erratic early in the fiscal year (needs `npm run enrich`) |
| `managementFee` | `number?` | Management fee % (needs `npm run enrich`) |
| `updatedAt` | `string` | ISO 8601 timestamp of the last successful scrape |

If nothing has been scraped yet (fresh install, no prior `npm run scrape`),
this endpoint scrapes once inline on the first request rather than
returning empty, so it's never dead in the water — every request after that
serves the cached copy.

**Freshness headers.** Alongside the body's `updatedAt`, the response carries
the last scrape time in two headers so consumers can check freshness without
parsing the payload:

| Header | Example | Notes |
|---|---|---|
| `Last-Modified` | `Thu, 20 Aug 2026 13:43:36 GMT` | Standard, second-resolution. Send it back as `If-Modified-Since` and you get a `304 Not Modified` (empty body) when the data hasn't changed, so you can poll cheaply |
| `X-Data-Updated-At` | `2026-08-20T13:43:36.905Z` | Full-precision ISO 8601, same value as the body's `updatedAt` |

Both are CORS-exposed, so frontend JS can read them directly. Note this is
*when your instance last scraped*, not a date published by MUFAP — MUFAP
doesn't expose a NAV date on the Fund Directory page. The scheduler skips
weekends, when MUFAP doesn't publish new NAVs.

### `GET /api/funds/:id`

One fund by its MUFAP `fundId`. `404` for unknown ids.

```bash
curl http://localhost:4000/api/funds/12768
```

### `GET /api/funds/:id/history`

The fund's accumulated NAV history, oldest first, with optional `from`/`to`
date bounds (inclusive, `YYYY-MM-DD`):

```bash
curl "http://localhost:4000/api/funds/12768/history?from=2026-08-01"
```

```json
{
  "fundId": "12768",
  "history": [
    { "date": "2026-08-30", "nav": 10.41, "offerPrice": 10.51 }
  ]
}
```

History accumulates from the day an instance first runs (one entry per
business day). Dates are scrape dates in Asia/Karachi — MUFAP doesn't expose
an official NAV date on the directory page.

### `GET /api/funds/:id/returns`

Trailing returns computed from the fund's accumulated history:

```json
{
  "fundId": "12768",
  "latestDate": "2026-08-30",
  "latestNav": 10.44,
  "returns": {
    "1m": { "pct": 2.68, "fromDate": "2026-07-30", "fromNav": 10.17 },
    "3m": null,
    "ytd": null,
    "1y": null,
    "sinceTracking": { "pct": 4.92, "fromDate": "2026-08-30", "fromNav": 9.95 }
  }
}
```

The formula is deliberately boring: simple NAV percentage change against the
most recent NAV on or before each period boundary, rounded to two decimals.
Not annualized, and payouts/dividends are not accounted for (this is NAV-only
data), so income-distributing funds will understate. A period is `null` until
the tracked history reaches back far enough — `sinceTracking` is always
available once a fund has two days of history.

### `GET /api/categories` and `GET /api/amcs`

Distinct fund categories / AMC names currently in the dataset, sorted —
handy for dropdowns and agent tool calls:

```bash
curl http://localhost:4000/api/categories
```

### `GET /health`

Plain liveness check — `{"ok": true}`.

## Data source & disclaimer

Data is scraped from MUFAP's public Fund Directory, refreshed on whatever
schedule you configure. This project is not affiliated with or endorsed by
MUFAP. NAVs and offer prices are provided as-is, for informational use —
verify against MUFAP directly before making any financial decision based on
this data. If MUFAP changes their page markup, the scraper's parsing logic
(`src/scraper.ts`) will need updating.

## Author

Built by [Saad Salman](https://saadsalman.org). If you found this useful,
[subscribe to my blog](https://saadsalman.org) for more.

## License

MIT

## MCP server (for AI agents)

The [`mcp/`](mcp/) package exposes this data to any MCP client — Claude,
Cursor, or your own agents — as five tools (`list_funds`, `get_fund`,
`get_nav_history`, `get_returns`, `get_filters`). Zero setup: it reads the
public dataset by default, or set `API_BASE_URL` to use your own instance.

```bash
claude mcp add pakistan-mutual-funds -- npx -y pakistan-mutual-funds-mcp
```

An OpenAPI 3.1 spec for the REST API is served at `GET /openapi.json`.
