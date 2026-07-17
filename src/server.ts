import express from 'express'
import { readStore, writeStore } from './store.js'
import { scrapeMufapFundDirectory } from './scraper.js'

const PORT = Number(process.env.PORT || 4000)

export function createServer() {
  const app = express()

  // Wide-open CORS — this is meant to be called directly from frontend
  // JS on whatever site is consuming it, not just server-to-server.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    next()
  })

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/funds', async (_req, res) => {
    try {
      let store = await readStore()

      // Bootstrap case: nothing scraped yet (e.g. first run before the
      // scheduler's initial fetch has completed). Scrape once inline so
      // the endpoint isn't dead in the water, and cache it for next time.
      if (!store) {
        const funds = await scrapeMufapFundDirectory()
        store = await writeStore(funds)
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
