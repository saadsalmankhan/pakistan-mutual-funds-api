// Historical NAV backfill from MUFAP's "NAVs and Sale Loads" table
// (Industry/IndustryStatDaily?tab=3), which serves any date range as
// server-rendered HTML with one row per fund per business day.
//
//   npm run backfill                          # from 2022-01-01 to yesterday
//   npm run backfill -- --from=2019-01-01     # go deeper
//
// Fetches one calendar week per request (polite: ~3s between requests, retry
// with backoff past Cloudflare), validates every row's validity date against
// the requested range (MUFAP silently serves CURRENT data for out-of-range
// requests, so unvalidated rows would corrupt history), and merges entries
// into the per-fund NDJSON files date-sorted. Existing entries win on
// conflict. Progress lives in data/backfill-state.json, so an interrupted run
// resumes where it left off — re-running is always safe.
import 'dotenv/config'
import * as cheerio from 'cheerio'
import { gotScraping } from 'got-scraping'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { historyFile, historyDir } from './store.js'
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

// Merge new entries into a fund's NDJSON file: existing dates win, result
// stays date-sorted.
async function mergeFund(fundId: string, entries: HistoryEntry[]): Promise<number> {
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
  let added = 0
  for (const e of entries) {
    if (!existing.has(e.date)) {
      existing.set(e.date, e)
      added++
    }
  }
  if (!added) return 0
  const sorted = [...existing.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  await writeFile(file, sorted.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
  return added
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

async function main() {
  const from = arg('from', '2022-01-01')
  const to = arg('to', isoShift(new Date().toISOString().slice(0, 10), -1))
  await mkdir(historyDir(), { recursive: true })
  const state = await loadState()
  const chunks = weekChunks(from, to)
  const pending = chunks.filter(c => !state[`${c.from}_${c.to}`])
  console.log(`Backfill ${from} -> ${to}: ${chunks.length} week chunks, ${pending.length} to fetch`)

  let totalAdded = 0
  for (const [i, chunk] of pending.entries()) {
    const key = `${chunk.from}_${chunk.to}`
    process.stdout.write(`[${i + 1}/${pending.length}] ${key} ... `)
    const html = await fetchChunk(chunk.from, chunk.to)
    const byFund = parseChunk(html, chunk.from, chunk.to)
    let added = 0
    for (const [fundId, entries] of byFund) added += await mergeFund(fundId, entries)
    state[key] = true
    await saveState(state)
    totalAdded += added
    console.log(`${byFund.size} funds, +${added} entries`)
    await new Promise(r => setTimeout(r, PAUSE_MS + Math.random() * 1500))
  }
  console.log(`Done. Added ${totalAdded} history entries.`)
}

main().catch(e => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
