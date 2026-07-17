import { scrapeMufapFundDirectory } from './scraper.js'
import { writeStore } from './store.js'

const FETCH_TIMES_PER_DAY = Number(process.env.FETCH_TIMES_PER_DAY || 1)
// MUFAP publishes NAVs once per business day — they don't change intraday,
// so scraping more often than that just wastes requests against their
// site. Skippable via SKIP_WEEKENDS=false if you have a reason to poll
// every day regardless.
const SKIP_WEEKENDS = (process.env.SKIP_WEEKENDS ?? 'true') !== 'false'

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay()
  return day === 0 || day === 6
}

async function fetchAndStore(): Promise<void> {
  if (SKIP_WEEKENDS && isWeekend(new Date())) {
    console.log('[scheduler] Skipping fetch — weekend, MUFAP does not publish new NAVs')
    return
  }
  try {
    console.log('[scheduler] Fetching MUFAP fund directory...')
    const funds = await scrapeMufapFundDirectory()
    await writeStore(funds)
    console.log(`[scheduler] Stored ${funds.length} funds`)
  } catch (err) {
    console.error('[scheduler] Fetch failed:', err)
  }
}

export function startScheduler(): void {
  if (FETCH_TIMES_PER_DAY < 1) {
    console.log('[scheduler] FETCH_TIMES_PER_DAY < 1 — automatic fetching disabled. Use `npm run scrape` to fetch manually (e.g. from your own cron).')
    return
  }

  const intervalMs = (24 * 60 * 60 * 1000) / FETCH_TIMES_PER_DAY
  console.log(`[scheduler] Fetching ${FETCH_TIMES_PER_DAY}x/day (every ${(intervalMs / 60000).toFixed(0)} min)`)

  // Fetch once immediately on startup so the API has data right away,
  // rather than making the first caller wait up to a full interval.
  void fetchAndStore()
  setInterval(fetchAndStore, intervalMs)
}
