import express from 'express'
import { readStore, writeStore } from './store.js'
import { scrapeMufapFundDirectory } from './scraper.js'

const PORT = Number(process.env.PORT || 4000)

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
      let store = await readStore()

      // Bootstrap case: nothing scraped yet (e.g. first run before the
      // scheduler's initial fetch has completed). Scrape once inline so
      // the endpoint isn't dead in the water, and cache it for next time.
      if (!store) {
        const funds = await scrapeMufapFundDirectory()
        store = await writeStore(funds)
      }

      // Surface how fresh the data is: a standard Last-Modified header (for
      // caches and conditional requests) plus a full-precision copy of the
      // body's updatedAt. Both reflect the last successful scrape.
      const updatedAt = new Date(store.updatedAt)
      res.setHeader('Last-Modified', updatedAt.toUTCString())
      res.setHeader('X-Data-Updated-At', store.updatedAt)

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

      res.json(store)
    } catch (err) {
      console.error('Failed to serve fund data:', err)
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
