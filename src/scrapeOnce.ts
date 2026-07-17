// One-off scrape, meant for wiring up to your own scheduler instead of the
// built-in one (system cron, GitHub Actions, Vercel Cron, etc.) — run
// `npm run scrape` and exit. Does not start the API server.
import 'dotenv/config'
import { scrapeMufapFundDirectory } from './scraper.js'
import { writeStore } from './store.js'

const funds = await scrapeMufapFundDirectory()
const store = await writeStore(funds)
console.log(`Stored ${store.funds.length} funds (updated ${store.updatedAt})`)
