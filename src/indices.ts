// End-of-day history for the PSX indices that fund returns are held against,
// from the PSX Data Portal's public JSON, stored per index as NDJSON.
//
//   npm run indices
//
// KSE-100 is the benchmark for conventional equity funds and KMI-30 for
// Shariah-compliant ones. Both are TOTAL RETURN indices (PSX's methodology
// brochures: dividends are adjusted into the index; the price-only variant is
// published separately as KSE100PR), so they compare fairly with a fund's
// payout-reinvested return.
//
// The portal serves a rolling window of about five years, so merging into the
// file on every run is what lets the stored history outgrow that window.
import 'dotenv/config'
import { indexFile, mergeDated } from './store.js'
import type { IndexEntry } from './types.js'

// Display name (what Fund.benchmark says) -> PSX symbol
export const INDICES: Record<string, string> = { 'KSE-100': 'KSE100', 'KMI-30': 'KMI30' }

const MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRAPE_ATTEMPTS) || 5)

// Rows are [unixSeconds, close, volume, open?]. PSX stamps the close at
// 16:00 PKT (11:00 UTC), so the UTC calendar date is the Karachi trading date.
//
// Plain fetch on purpose. Unlike MUFAP, the portal has no bot wall, and
// got-scraping's browser-impersonating TLS handshake is what breaks here:
// from GitHub's runners PSX hung up on every impersonated request ("socket
// hang up") while answering plain curl in two seconds.
async function fetchIndex(symbol: string): Promise<IndexEntry[]> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 3000))
    try {
      const res = await fetch(`https://dps.psx.com.pk/timeseries/eod/${symbol}`, {
        headers: { accept: 'application/json', 'user-agent': 'pakistan-mutual-funds-api (+https://github.com/saadsalmankhan/pakistan-mutual-funds-api)' },
        signal: AbortSignal.timeout(30000),
      })
      const body = (res.ok ? await res.json() : null) as { status?: number; data?: unknown } | null
      if (Array.isArray(body?.data) && body.data.length) {
        const entries: IndexEntry[] = []
        // Oldest first, so if PSX ever lists a date twice the later stamp wins.
        const rows = [...(body.data as unknown[][])].sort((a, b) => Number(a[0]) - Number(b[0]))
        for (const row of rows) {
          const ts = Number(row[0])
          const close = Number(row[1])
          if (!ts || !(close > 0)) continue
          entries.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), close })
        }
        if (entries.length) return entries
      }
      lastError = new Error(`PSX returned HTTP ${res.status} without index data`)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`PSX ${symbol} fetch failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : lastError}`)
}

// Fetch and merge every index. Returns how many failed.
export async function refreshIndices(): Promise<number> {
  let failed = 0
  for (const [name, symbol] of Object.entries(INDICES)) {
    try {
      const entries = await fetchIndex(symbol)
      const changed = await mergeDated(indexFile(name), entries)
      const dates = entries.map(e => e.date).sort()
      console.log(`${name}: ${entries.length} closes ${dates[0]} -> ${dates[dates.length - 1]}, ${changed} added or updated`)
    } catch (err) {
      failed++
      console.error(`${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return failed
}

// Only run when invoked as a script (performance.ts imports INDICES).
if (process.argv[1] && /indices\.(ts|js)$/.test(process.argv[1])) {
  refreshIndices()
    .then(failed => { if (failed) process.exit(1) })
    .catch(e => {
      console.error('ERROR:', e.message)
      process.exit(1)
    })
}
