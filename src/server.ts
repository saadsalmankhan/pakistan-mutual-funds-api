import express from 'express'
import type { Request, Response } from 'express'
import { readStore, writeStore, readHistory } from './store.js'
import { scrapeMufapFundDirectory } from './scraper.js'
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
      let funds = store.funds
      if (category) funds = funds.filter(f => f.category.toLowerCase() === category)
      if (amc) funds = funds.filter(f => f.amc.toLowerCase() === amc)
      if (q) funds = funds.filter(f => f.name.toLowerCase().includes(q))

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
