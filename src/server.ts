import express from 'express'
import type { Request, Response } from 'express'
import { readStore, writeStore, readHistory, readIndex, readPayouts } from './store.js'
import { scrapeMufapFundDirectory } from './scraper.js'
import { computeReturns, PERIODS } from './returns.js'
import type { Period } from './returns.js'
import { amcTable, buildPerformance, leagueTable, loadBenchmarks, summarize, PERFORMANCE_NOTE } from './performance.js'
import type { PerformanceFile } from './performance.js'
import { INDICES } from './indices.js'
import { openapi } from './openapi.js'
import type { FundStore } from './types.js'

const PORT = Number(process.env.PORT || 4000)

// Bootstrap case: nothing scraped yet (e.g. first run before the scheduler's
// initial fetch has completed). Scrape once inline so no endpoint is dead in
// the water, and cache it for next time.
async function loadStore(): Promise<FundStore> {
  const store = await readStore()
  if (store) return store
  const funds = await scrapeMufapFundDirectory()
  return writeStore(funds)
}

// Surface how fresh the data is: a standard Last-Modified header (for caches
// and conditional requests) plus a full-precision copy of the body's
// updatedAt. Both reflect the last successful scrape.
function setFreshnessHeaders(res: Response, store: FundStore): Date {
  const updatedAt = new Date(store.updatedAt)
  res.setHeader('Last-Modified', updatedAt.toUTCString())
  res.setHeader('X-Data-Updated-At', store.updatedAt)
  return updatedAt
}

function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name]
  return typeof value === 'string' && value.length ? value : undefined
}

// The league table reads every fund's history and payouts (~1,100 files), so
// build it once per snapshot and reuse it until the next scrape lands.
let performanceCache: { key: string; perf: Promise<PerformanceFile> } | null = null
function loadPerformance(store: FundStore): Promise<PerformanceFile> {
  if (performanceCache?.key !== store.updatedAt) {
    const perf = buildPerformance(store)
    perf.catch(() => { performanceCache = null })
    performanceCache = { key: store.updatedAt, perf }
  }
  return performanceCache.perf
}

// "kse100", "KSE-100" and "kse 100" all name the same index.
function benchmarkName(input: string): string | undefined {
  const flat = input.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return Object.keys(INDICES).find(name => INDICES[name] === flat)
}

// Shared by /api/performance and /api/performance/amcs: parse the filters and
// produce the league rows, or send the 4xx and return null.
async function leagueFromRequest(req: Request, res: Response) {
  const period = (queryParam(req, 'period') ?? '1y') as Period
  if (!PERIODS.includes(period)) {
    res.status(400).json({ error: `Unknown period. Use one of: ${PERIODS.join(', ')}` })
    return null
  }
  const benchmarkInput = queryParam(req, 'benchmark')
  const benchmark = benchmarkInput ? benchmarkName(benchmarkInput) : undefined
  if (benchmarkInput && !benchmark) {
    res.status(400).json({ error: `Unknown benchmark. Use one of: ${Object.keys(INDICES).join(', ')}` })
    return null
  }
  const store = await loadStore()
  setFreshnessHeaders(res, store)
  const perf = await loadPerformance(store)
  const shariah = queryParam(req, 'shariah')?.toLowerCase()
  const style = queryParam(req, 'style') ?? 'active'
  if (style !== 'active' && style !== 'passive' && style !== 'all') {
    res.status(400).json({ error: 'Unknown style. Use one of: active, passive, all' })
    return null
  }
  const override = benchmark ? (await loadBenchmarks()).get(benchmark) : undefined
  if (benchmark && !override) {
    res.status(503).json({ error: `No ${benchmark} history yet — run \`npm run indices\`` })
    return null
  }
  const rows = leagueTable(perf, {
    period,
    category: queryParam(req, 'category'),
    amc: queryParam(req, 'amc'),
    q: queryParam(req, 'q'),
    shariah: shariah === 'true' ? true : shariah === 'false' ? false : undefined,
    benchmark,
    style,
    includeStale: queryParam(req, 'includeStale') === 'true',
    includeFlagged: queryParam(req, 'includeFlagged') === 'true',
  }, override)
  return { period, perf, rows }
}

export function createServer() {
  const app = express()

  // Wide-open CORS — this is meant to be called directly from frontend
  // JS on whatever site is consuming it, not just server-to-server.
  // Expose the freshness headers so browser JS can actually read them.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, X-Data-Updated-At')
    next()
  })

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/openapi.json', (_req, res) => {
    res.json(openapi)
  })

  app.get('/api/funds', async (req, res) => {
    try {
      const store = await loadStore()
      const updatedAt = setFreshnessHeaders(res, store)

      // Honour If-Modified-Since so clients can cheaply poll for new NAVs
      // without re-downloading the payload. Last-Modified is second-
      // resolution, so compare floored to whole seconds.
      const ims = req.headers['if-modified-since']
      if (ims) {
        const since = Date.parse(ims)
        if (!Number.isNaN(since) && Math.floor(updatedAt.getTime() / 1000) <= Math.floor(since / 1000)) {
          res.status(304).end()
          return
        }
      }

      // Optional filters, all case-insensitive: exact category/AMC match,
      // and q as a substring of the fund name.
      const category = queryParam(req, 'category')?.toLowerCase()
      const amc = queryParam(req, 'amc')?.toLowerCase()
      const q = queryParam(req, 'q')?.toLowerCase()
      const shariah = queryParam(req, 'shariah')?.toLowerCase()
      let funds = store.funds
      if (category) funds = funds.filter(f => f.category.toLowerCase() === category)
      if (amc) funds = funds.filter(f => f.amc.toLowerCase() === amc)
      if (q) funds = funds.filter(f => f.name.toLowerCase().includes(q))
      if (shariah === 'true' || shariah === 'false') {
        funds = funds.filter(f => f.shariah === (shariah === 'true'))
      }

      res.json({ funds, updatedAt: store.updatedAt })
    } catch (err) {
      console.error('Failed to serve fund data:', err)
      res.status(502).json({ error: 'Failed to fetch fund data' })
    }
  })

  app.get('/api/funds/:id/history', async (req, res) => {
    try {
      const from = queryParam(req, 'from')
      const to = queryParam(req, 'to')
      const history = await readHistory(req.params.id, from, to)
      if (history === null) {
        res.status(404).json({ error: 'No history for this fund id (yet)' })
        return
      }
      res.json({ fundId: req.params.id, history })
    } catch (err) {
      console.error('Failed to serve fund history:', err)
      res.status(500).json({ error: 'Failed to read fund history' })
    }
  })

  app.get('/api/funds/:id/payouts', async (req, res) => {
    try {
      const from = queryParam(req, 'from')
      const to = queryParam(req, 'to')
      let payouts = await readPayouts(req.params.id)
      if (from) payouts = payouts.filter(p => p.date >= from)
      if (to) payouts = payouts.filter(p => p.date <= to)
      res.json({ fundId: req.params.id, payouts })
    } catch (err) {
      console.error('Failed to serve fund payouts:', err)
      res.status(500).json({ error: 'Failed to read fund payouts' })
    }
  })

  app.get('/api/funds/:id/returns', async (req, res) => {
    try {
      const history = await readHistory(req.params.id)
      // The benchmark comes from the fund record; returns still work without
      // a snapshot or index files, just with the comparison fields null.
      const fund = (await readStore())?.funds.find(f => f.fundId === req.params.id)
      const entries = fund?.benchmark ? await readIndex(fund.benchmark) : null
      const benchmark = fund?.benchmark && entries?.length ? { name: fund.benchmark, entries } : undefined
      const result = history === null ? null : computeReturns(history, await readPayouts(req.params.id), benchmark)
      if (!result) {
        res.status(404).json({ error: 'No history for this fund id (yet)' })
        return
      }
      res.json({
        fundId: req.params.id,
        ...result,
        note: PERFORMANCE_NOTE + ' A period is null until tracked history reaches back far enough.',
      })
    } catch (err) {
      console.error('Failed to serve fund returns:', err)
      res.status(500).json({ error: 'Failed to compute fund returns' })
    }
  })

  app.get('/api/funds/:id', async (req, res) => {
    try {
      const store = await loadStore()
      setFreshnessHeaders(res, store)
      const fund = store.funds.find(f => f.fundId === req.params.id)
      if (!fund) {
        res.status(404).json({ error: 'Unknown fund id' })
        return
      }
      res.json({ ...fund, updatedAt: store.updatedAt })
    } catch (err) {
      console.error('Failed to serve fund:', err)
      res.status(502).json({ error: 'Failed to fetch fund data' })
    }
  })

  // Who beat the market after fees: funds ranked by return in excess of
  // their benchmark index, best first.
  app.get('/api/performance', async (req, res) => {
    try {
      const league = await leagueFromRequest(req, res)
      if (!league) return
      const { period, perf, rows } = league
      const order = queryParam(req, 'order') === 'asc' ? 'asc' : 'desc'
      const sorted = queryParam(req, 'sort') === 'return' ? [...rows].sort((a, b) => b.pct - a.pct) : rows
      if (order === 'asc') sorted.reverse()
      const limit = Math.min(Math.max(Math.floor(Number(queryParam(req, 'limit'))) || sorted.length, 1), sorted.length || 1)
      res.json({
        period,
        asOf: perf.asOf,
        benchmarks: Object.fromEntries(Object.entries(perf.benchmarks).map(([name, b]) => [name, b.returns[period]])),
        summary: summarize(rows),
        funds: sorted.slice(0, limit),
        note: PERFORMANCE_NOTE,
      })
    } catch (err) {
      console.error('Failed to serve performance:', err)
      res.status(500).json({ error: 'Failed to compute performance' })
    }
  })

  app.get('/api/performance/amcs', async (req, res) => {
    try {
      const league = await leagueFromRequest(req, res)
      if (!league) return
      const { period, perf, rows } = league
      res.json({ period, asOf: perf.asOf, summary: summarize(rows), amcs: amcTable(rows), note: PERFORMANCE_NOTE })
    } catch (err) {
      console.error('Failed to serve AMC performance:', err)
      res.status(500).json({ error: 'Failed to compute performance' })
    }
  })

  app.get('/api/benchmarks', async (_req, res) => {
    try {
      const store = await loadStore()
      setFreshnessHeaders(res, store)
      const perf = await loadPerformance(store)
      res.json({ benchmarks: perf.benchmarks, asOf: perf.asOf })
    } catch (err) {
      console.error('Failed to serve benchmarks:', err)
      res.status(500).json({ error: 'Failed to read benchmarks' })
    }
  })

  app.get('/api/benchmarks/:name/history', async (req, res) => {
    try {
      const name = benchmarkName(req.params.name)
      const history = name ? await readIndex(name, queryParam(req, 'from'), queryParam(req, 'to')) : null
      if (!name || history === null) {
        res.status(404).json({ error: `Unknown benchmark or no history yet. Known: ${Object.keys(INDICES).join(', ')}` })
        return
      }
      res.json({ benchmark: name, history })
    } catch (err) {
      console.error('Failed to serve benchmark history:', err)
      res.status(500).json({ error: 'Failed to read benchmark history' })
    }
  })

  app.get('/api/categories', async (_req, res) => {
    try {
      const store = await loadStore()
      setFreshnessHeaders(res, store)
      const categories = [...new Set(store.funds.map(f => f.category).filter(Boolean))].sort()
      res.json({ categories, updatedAt: store.updatedAt })
    } catch (err) {
      console.error('Failed to serve categories:', err)
      res.status(502).json({ error: 'Failed to fetch fund data' })
    }
  })

  app.get('/api/amcs', async (_req, res) => {
    try {
      const store = await loadStore()
      setFreshnessHeaders(res, store)
      const amcs = [...new Set(store.funds.map(f => f.amc).filter(Boolean))].sort()
      res.json({ amcs, updatedAt: store.updatedAt })
    } catch (err) {
      console.error('Failed to serve AMCs:', err)
      res.status(502).json({ error: 'Failed to fetch fund data' })
    }
  })

  return app
}

export function startServer(): void {
  const app = createServer()
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`)
  })
}
