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
- **Cloudflare handling** (`src/mufap.ts`) — MUFAP sits behind Cloudflare's
  bot protection, so a plain request gets a `403`. Every MUFAP fetch goes
  through [got-scraping](https://github.com/apify/got-scraping), which sends
  the page request with a real browser's TLS fingerprint and header order.
  The fingerprint is pinned to Firefox: Cloudflare waves that through almost
  every time from a home connection and about half the time from a
  datacenter IP such as a GitHub Actions runner, while Chrome (got-scraping's
  default) and Safari fingerprints get challenged far more often, and from a
  datacenter IP every single time. This is
  automatic: no clearance cookies, no headless browser and no config, so a
  fresh clone works out of the box. The fetch still retries a few times past
  the odd challenge before giving up.
- **Storage** (`src/store.ts`) writes the result to a local JSON file
  (`./data/funds.json` by default) — no database required.
- **History** — every successful scrape also appends each fund's NAV to a
  per-fund NDJSON file under `./data/history/`, one entry per day, so an
  instance accumulates a NAV time series from the day it starts running.
  MUFAP doesn't publish a NAV date on the directory page, so live appends are
  keyed by the scrape date in MUFAP's timezone (Asia/Karachi); a re-scrape
  on the same date replaces that day's entry if MUFAP corrected the values.
  For history keyed by MUFAP's *published* NAV validity dates (correct no
  matter when your scheduler actually runs), use the backfill instead — see
  [Backfilling history](#backfilling-history).
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
- **Payouts** (`src/payouts.ts`, `npm run payouts`) scrapes MUFAP's Payouts
  table into per-fund NDJSON: payout per unit, ex-NAV and date. This is what
  turns NAV change into a total return, see
  [Total returns and beating the market](#total-returns-and-beating-the-market).
- **Indices** (`src/indices.ts`, `npm run indices`) pulls KSE-100 and KMI-30
  end-of-day closes from the PSX Data Portal, the benchmarks funds are held
  against.
- **Performance** (`src/performance.ts`, `npm run performance`) builds the
  league table behind `/api/performance` and can write it to a single
  `performance.json` for static hosting.

## Configuration

All via environment variables (see `.env.example`):

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port the API server listens on |
| `FETCH_TIMES_PER_DAY` | `1` | How often the built-in scheduler re-scrapes. Set to `0` to disable it entirely (see below) |
| `SKIP_WEEKENDS` | `true` | Skip scheduled fetches on Sat/Sun — MUFAP doesn't publish new NAVs on weekends |
| `DATA_FILE` | `./data/funds.json` | Where scraped data is stored on disk |
| `HISTORY_DIR` | `./data/history` | Where per-fund NAV history (NDJSON) accumulates |
| `SKIP_HISTORY` | `false` | `true` stops `npm run scrape` writing history rows — for setups that merge dated history via the backfill instead |
| `META_FILE` | `./data/meta.json` | Where `npm run enrich` stores expense ratios and inception dates |
| `PAYOUTS_DIR` | `./data/payouts` | Where per-fund payout history (NDJSON) accumulates |
| `INDEX_DIR` | `./data/indices` | Where benchmark index history (NDJSON) accumulates |
| `PERFORMANCE_FILE` | `./data/performance.json` | Where `npm run performance` writes the league table |
| `SCRAPE_ATTEMPTS` | `5` | How many times to retry a MUFAP fetch past an occasional Cloudflare challenge |
| `SCRAPE_TIMEOUT_MS` | `60000` | Per-request timeout for MUFAP fetches, in milliseconds |

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

## Backfilling history

MUFAP's daily-stats table (`Industry/IndustryStatDaily`) publishes every NAV
*with its validity date*, at full 4-decimal precision — unlike the directory
page the live scraper reads. `npm run backfill` merges it into the same
per-fund NDJSON files:

```bash
npm run backfill                              # seed history from 2022-01-01
npm run backfill -- --from=2019-01-01         # go deeper
npm run backfill -- --recent=10 --overwrite   # re-merge the trailing 10 days
```

Existing rows win on conflict, except with `--overwrite`, which lets fresh
MUFAP rows replace same-date entries inside the fetched window. Running
`--recent=N --overwrite` after each scrape keeps history keyed by MUFAP's own
dates — immune to scheduler delay (a run that starts after midnight PKT can't
mis-date rows) — and picks up MUFAP's occasional corrections. That's exactly
what the [dataset repo](https://github.com/saadsalmankhan/pakistan-mutual-funds-data)'s
daily workflow does, paired with `SKIP_HISTORY=true` on the snapshot scrape.

## Total returns and beating the market

Asset managers charge around 3 to 4% a year to run an equity fund. The
question worth asking of that fee is whether the fund beat the index you
could have bought instead. Answering it takes three things the fund
directory does not give you, so the API collects them:

```bash
npm run payouts                 # every payout since 2022-01-01
npm run payouts -- --recent=45  # re-merge the trailing days (daily job)
npm run indices                 # KSE-100 and KMI-30 closes from PSX
npm run performance             # write data/performance.json (optional)
```

The built-in scheduler refreshes payouts and indices after every scrape. If
you run your own cron, add the two `--recent` style commands to it.

**Why payouts matter.** A payout drops the NAV by the amount paid without
the investor losing anything. Faysal Islamic Stock Fund's NAV went from
99.29 to 115.37 over the three years to 18 Sep 2026, which reads as +16%.
It also paid 65.76 and 43.80 per unit along the way. Reinvest those at the
ex-NAV and the real return is +189.9%. MUFAP's own figure is +189.41%.

**Method.** Total return = NAV growth multiplied by `1 + payout / exNAV` for
every payout in the window. Returns are net of fees because fees come out of
the NAV, cumulative, never annualized. The benchmark is measured over the
exact same two dates: KSE-100 for conventional equity categories and KMI-30
for Shariah ones. Both are total-return indices (PSX publishes the
price-only variant separately as KSE100PR), so the comparison is like for
like. `excessPct` is fund minus index in percentage points.

**Validation.** `npm run validate` checks these returns against MUFAP's own
payout-adjusted Performance Summary. In Sep 2026, across every fund MUFAP
reports on an absolute basis: 1 year and 2 year figures within 1 percentage
point for all 140 and 125 funds compared, 3 year within 1 point for 93% of
116 and within 5 for 99%. The NAV-only method this replaces was off by a
median of 33 points over 3 years.

**Dirty source data, and what is done about it.** MUFAP's tables are typed in
by about 25 asset managers:

- One-day bad values (a pension scheme's equity and debt NAVs transposed for
  a day) are dropped, so a period boundary can't land on one.
- Payout dates that trail the NAV drop by a day or three are re-dated to the
  day the NAV actually fell, and a dividend listed twice is counted once.
  One fund's official 3 year figure differs from this API's for that reason:
  MUFAP counts Alfalah GHP Dedicated Equity Fund's June 2024 dividend twice.
- A one-day NAV level shift above 35% with no payout behind it (a 10-for-1
  unit consolidation reads as +900%) is **not** rewritten, because a small
  fund can really gain that much on a provision reversal and the numbers
  can't tell the two apart. The period is computed at face value, flagged
  with `anomalies`, and left out of league tables unless you pass
  `includeFlagged=true`.

**Read the league table with these in mind.** Closed and merged funds vanish
from MUFAP's directory, so the share of funds beating the index is flattered
(survivorship bias). An index can't be bought at zero cost. Index trackers
and ETFs are built to match the index, so they are listed separately
(`style=passive`). And three years to Sep 2026 was one long bull market, in
which any cash a fund holds drags on it.

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
business day). Rows merged by `npm run backfill` carry MUFAP's published NAV
validity dates; rows appended live by the scraper are keyed by the Asia/Karachi
scrape date, since MUFAP doesn't expose a NAV date on the directory page.

### `GET /api/funds/:id/returns`

Trailing total returns next to the fund's benchmark:

```json
{
  "fundId": "12896",
  "latestDate": "2026-09-18",
  "latestNav": 115.367,
  "benchmark": "KMI-30",
  "returns": {
    "1y": { "pct": -2.35, "navPct": -2.35, "fromDate": "2025-09-18", "fromNav": 118.1468,
            "payouts": 0, "anomalies": 0, "benchmarkPct": 4.49, "excessPct": -6.84 },
    "3y": { "pct": 189.89, "navPct": 16.19, "fromDate": "2023-09-18", "fromNav": 99.2878,
            "payouts": 2, "anomalies": 0, "benchmarkPct": 213.71, "excessPct": -23.82 }
  }
}
```

Periods: `1m`, `3m`, `6m`, `ytd`, `fytd` (Pakistani fiscal year to date, from
June 30), `1y`, `2y`, `3y` and `sinceTracking`. `pct` is the total return
with payouts reinvested, `navPct` the NAV-only change. `benchmarkPct` and
`excessPct` are `null` for funds without a benchmark. A period is `null`
until tracked history reaches back far enough. See
[Total returns and beating the market](#total-returns-and-beating-the-market)
for the method.

> Before v1.3 `pct` was the NAV-only change. It is now the total return,
> which is the number almost everyone wanted. The old value lives on as
> `navPct`.

### `GET /api/funds/:id/payouts`

Payout history, oldest first: `{ "fundId", "payouts": [{ "date", "payout", "exNav" }] }`.
Takes `from` and `to` like `/history`. Empty for a fund that never paid out.

### `GET /api/performance`

Who beat the market after fees. Funds ranked by return in excess of their
benchmark, best first. `GET /api/performance?period=3y&category=Equity`:

```json
{
  "period": "3y",
  "asOf": "2026-09-18",
  "benchmarks": { "KSE-100": 273.08, "KMI-30": 213.71 },
  "summary": { "funds": 25, "beatBenchmark": 7, "beatBenchmarkPct": 28,
               "medianPct": 238.98, "medianExcessPct": -34.1, "avgExpenseRatio": 3.78 },
  "funds": [
    { "fundId": "13081", "name": "NBP Financial Sector Fund", "amc": "NBP Fund Management Limited",
      "category": "Equity", "benchmark": "KSE-100", "passive": false, "expenseRatio": 3.24,
      "pct": 408.84, "navPct": 146.56, "benchmarkPct": 269.46, "excessPct": 139.38,
      "beatBenchmark": true, "anomalies": 0, "fromDate": "2023-09-15", "asOf": "2026-09-17" }
  ]
}
```

| Param | Meaning |
|---|---|
| `period` | One of the periods above, default `1y` |
| `category`, `amc`, `q`, `shariah` | Same filters as `/api/funds` |
| `style` | `active` (default), `passive` (index trackers and ETFs) or `all` |
| `benchmark` | `KSE-100` or `KMI-30`: hold every selected fund against this index instead of its own. Without it only funds that have a benchmark are listed |
| `sort`, `order`, `limit` | `sort=return` ranks by return instead of excess, `order=asc` puts the worst first |
| `includeStale`, `includeFlagged` | Include funds that stopped reporting, or whose window holds a NAV anomaly |

`GET /api/performance/amcs` takes the same filters and rolls the table up per
asset manager: funds counted, how many beat their benchmark, average excess
return, average expense ratio, best and worst fund.

### `GET /api/benchmarks` and `GET /api/benchmarks/:name/history`

The indices' latest close and their own trailing returns, and the daily
closes (`from`/`to` supported). Names ignore case and punctuation, so
`kse100` works.

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
Cursor, or your own agents — as six tools (`list_funds`, `get_fund`,
`get_nav_history`, `get_returns`, `get_performance`, `get_filters`). Zero setup: it reads the
public dataset by default, or set `API_BASE_URL` to use your own instance.

```bash
claude mcp add pakistan-mutual-funds -- npx -y pakistan-mutual-funds-mcp
```

There is also a hosted connector for claude.ai and ChatGPT, nothing to
install: add `https://funds.saadsalman.org/mcp` as a custom connector. Setup
steps are at [funds.saadsalman.org](https://funds.saadsalman.org) and in the
[`mcp/` README](mcp/README.md).

An OpenAPI 3.1 spec for the REST API is served at `GET /openapi.json`.
