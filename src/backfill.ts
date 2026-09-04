// Historical NAV backfill from MUFAP's "NAVs and Sale Loads" table
// (Industry/IndustryStatDaily?tab=3), which serves any date range as
// server-rendered HTML with one row per fund per business day.
//
//   npm run backfill                              # from 2022-01-01 to yesterday
//   npm run backfill -- --from=2019-01-01         # go deeper
//   npm run backfill -- --recent=10 --overwrite   # re-merge the trailing days
//
// Fetches one calendar week per request (polite: ~3s between requests, retry
// with backoff past Cloudflare), validates every row's validity date against
// the requested range (MUFAP silently serves CURRENT data for out-of-range
// requests, so unvalidated rows would corrupt history), and merges entries
// into the per-fund NDJSON files date-sorted. Existing entries win on
// conflict unless --overwrite, which lets fresh MUFAP rows replace same-date
// entries — the dataset workflow runs `--recent=N --overwrite` after every
// snapshot so history carries MUFAP's own validity dates (immune to however
// late GitHub starts the job) and picks up MUFAP's corrections. Progress
// lives in data/backfill-state.json, so an interrupted run resumes where it
// left off — re-running is always safe. --recent skips that state entirely:
// its whole point is re-fetching the same window every day.
import 'dotenv/config'
import * as cheerio from 'cheerio'
import { gotScraping } from 'got-scraping'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { historyFile, historyDir, karachiDate } from './store.js'
import type { HistoryEntry } from './types.js'

const STATE_FILE = process.env.BACKFILL_STATE_FILE || './data/backfill-state.json'
const MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRAPE_ATTEMPTS) || 5)
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.SCRAPE_TIMEOUT_MS) || 60000)
const PAUSE_MS = 3000

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

// "Aug 24, 2026" -> "2026-08-24" (manual parse: no timezone surprises)
function parseMufapDate(text: string): string | null {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/.exec(text.trim())
  if (!m || !MONTHS[m[1]]) return null
  return `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`
}

function parseNumber(text: string): number {
  const n = parseFloat(text.replace(/,/g, '').trim())
  return isNaN(n) ? 0 : n
}

function isoShift(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Monday-to-Friday chunks covering [from, to]
function weekChunks(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = []
  let d = new Date(from + 'T00:00:00Z')
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7)) // back to Monday
  const end = new Date(to + 'T00:00:00Z')
  while (d <= end) {
    const mon = d.toISOString().slice(0, 10)
    const fri = isoShift(mon, 4)
    chunks.push({ from: mon < from ? from : mon, to: fri > to ? to : fri })
    d.setUTCDate(d.getUTCDate() + 7)
  }
  return chunks
}

async function fetchChunk(from: string, to: string): Promise<string> {
  const url =
    'https://www.mufap.com.pk/Industry/IndustryStatDaily' +
    `?tab=3&AMCId=0&fundId=0&datefrom=${from}&datetill=${to}`
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 5000))
    try {
      const res = await gotScraping({ url, timeout: { request: REQUEST_TIMEOUT_MS }, retry: { limit: 0 } })
      if (res.statusCode === 200 && res.body.includes('fund-block')) return res.body
      lastError = new Error(`HTTP ${res.statusCode} without fund data`)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`chunk ${from}..${to} failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : lastError}`)
}

// Cell layout (tab=3): [0] Sector (hidden) [1] AMC (hidden) [2] Fund
// [3] Category [4] Inception Date [5] Offer [6] Repurchase [7] NAV
// [8] Validity Date [9+] loads/trustee
function parseChunk(html: string, from: string, to: string): Map<string, HistoryEntry[]> {
  const $ = cheerio.load(html)
  const byFund = new Map<string, HistoryEntry[]>()
  let dropped = 0
  $('tr.fund-block').each((_, row) => {
    const $row = $(row)
    const detailHref = $row.find('a[href*="FundDetail?FundID="]').attr('href') ?? ''
    const fundId = detailHref.split('FundID=')[1]
    if (!fundId) return
    const cells = $row.find('td').map((_, td) => $(td).text().trim()).get()
    const date = parseMufapDate(cells[8] ?? '')
    if (!date || date < from || date > to) { dropped++; return } // out-of-range guard
    const nav = parseNumber(cells[7] ?? '')
    const offerPrice = parseNumber(cells[5] ?? '')
    if (nav <= 0) return
    let list = byFund.get(fundId)
    if (!list) byFund.set(fundId, (list = []))
    list.push({ date, nav, offerPrice })
  })
  if (dropped > 0) console.log(`  (${dropped} out-of-range rows dropped)`)
  return byFund
}

// Merge new entries into a fund's NDJSON file, result date-sorted. Existing
// dates win by default; with overwrite, MUFAP's row replaces a same-date
// entry whose values differ (fixing mis-dated or corrected rows in-window —
// parseChunk's range guard means only requested dates ever get here).
async function mergeFund(fundId: string, entries: HistoryEntry[], overwrite: boolean): Promise<number> {
  const file = historyFile(fundId)
  const existing = new Map<string, HistoryEntry>()
  try {
    for (const line of (await readFile(file, 'utf-8')).split('\n')) {
      if (!line) continue
      const e = JSON.parse(line) as HistoryEntry
      existing.set(e.date, e)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  let changed = 0
  for (const e of entries) {
    const prev = existing.get(e.date)
    const replace = prev && overwrite && (prev.nav !== e.nav || prev.offerPrice !== e.offerPrice)
    if (!prev || replace) {
      existing.set(e.date, e)
      changed++
    }
  }
  if (!changed) return 0
  const sorted = [...existing.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  await writeFile(file, sorted.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
  return changed
}

async function loadState(): Promise<Record<string, boolean>> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf-8')) as Record<string, boolean>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function saveState(state: Record<string, boolean>): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 1), 'utf-8')
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main() {
  const recentDays = Math.floor(Number(arg('recent', '0')))
  const overwrite = hasFlag('overwrite')
  // --recent windows end at today in Karachi so an evening run catches the
  // NAVs MUFAP published a few hours earlier; the range guard drops today's
  // dates when they aren't out yet.
  const from = recentDays > 0 ? isoShift(karachiDate(), -recentDays) : arg('from', '2022-01-01')
  const to = recentDays > 0 ? karachiDate() : arg('to', isoShift(new Date().toISOString().slice(0, 10), -1))
  await mkdir(historyDir(), { recursive: true })
  const state = recentDays > 0 ? {} : await loadState()
  const chunks = weekChunks(from, to)
  const pending = chunks.filter(c => !state[`${c.from}_${c.to}`])
  const mode = `${overwrite ? ', MUFAP rows win in-window' : ''}`
  console.log(`Backfill ${from} -> ${to}: ${chunks.length} week chunks, ${pending.length} to fetch${mode}`)

  let totalChanged = 0
  for (const [i, chunk] of pending.entries()) {
    const key = `${chunk.from}_${chunk.to}`
    process.stdout.write(`[${i + 1}/${pending.length}] ${key} ... `)
    const html = await fetchChunk(chunk.from, chunk.to)
    const byFund = parseChunk(html, chunk.from, chunk.to)
    let changed = 0
    for (const [fundId, entries] of byFund) changed += await mergeFund(fundId, entries, overwrite)
    if (recentDays <= 0) {
      state[key] = true
      await saveState(state)
    }
    totalChanged += changed
    console.log(`${byFund.size} funds, ${changed} rows added or updated`)
    await new Promise(r => setTimeout(r, PAUSE_MS + Math.random() * 1500))
  }
  console.log(`Done. ${totalChanged} history rows added or updated.`)
}

main().catch(e => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
