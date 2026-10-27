// End-of-day history for the PSX indices that fund returns are held against,
// stored per index as NDJSON, with every close cross-checked across sources.
//
//   npm run indices                       # re-merge the trailing 45 days
//   npm run indices -- --from=2015-01-01  # backfill (any range)
//
// KSE-100 is the benchmark for conventional equity funds and KMI-30 for
// Shariah-compliant ones. Both are TOTAL RETURN indices (PSX's methodology
// brochures: dividends are adjusted into the index; the price-only variant is
// published separately as KSE100PR), so they compare fairly with a fund's
// payout-reinvested return.
//
// Why several sources. PSX sells its historical feed to data vendors (that's
// where Investing.com and the like get theirs) and offers no free API. Its
// Data Portal used to answer /timeseries/eod/<symbol> with five years of
// closes; in late Sep 2026 it closed that to outside callers without notice,
// and because it was the only source, every benchmark comparison quietly went
// blank for a month. So now:
//
//   scstrade     scstrade.com, a Pakistani brokerage's market-data site:
//                dated daily closes for any range through a public JSON
//                method behind its Historical Indices page. Identical to the
//                paisa to what PSX served, on all 179 overlapping days of
//                2026. The only free source of HISTORY, so it fills gaps.
//   psx          PSX's own Indices page: latest value plus an "As of" date,
//                as plain HTML. Official, latest close only.
//   tradingview  TradingView's public screener endpoint: latest value, no
//                date. Can only confirm a close another source has dated.
//
// Every run asks all three, and each date is settled by the sources that
// cover it (see reconcile below). Once stored, a close never changes, so the
// cross-check that matters is the newest day, where all three overlap. Any
// one source can go down without a gap; sources that disagree are reported
// and never silently overwrite a stored close. indices/sources.json records
// what each source said on the last run, for the health check to read.
import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { gotScraping } from 'got-scraping'
import { indexFile, indexStatusFile, karachiDate, mergeDated, readIndex } from './store.js'
import type { IndexEntry } from './types.js'

// Display name (what Fund.benchmark says) -> PSX symbol
export const INDICES: Record<string, string> = { 'KSE-100': 'KSE100', 'KMI-30': 'KMI30' }
// Display name -> the name scstrade's index picker uses
const SCSTRADE_NAMES: Record<string, string> = { 'KSE-100': 'KSE 100', 'KMI-30': 'KMI 30' }

export type Source = 'psx' | 'scstrade' | 'tradingview'
// When agreeing sources differ in the last decimals, keep the official one.
const PRIORITY: Source[] = ['psx', 'scstrade', 'tradingview']

// Two closes count as the same number within this relative gap. Real
// disagreements (a mis-dated row, a stale page, a wrong index) are a typical
// day's move apart, 0.3% and up; rounding differences are far below this.
const TOLERANCE = 0.0005

const MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRAPE_ATTEMPTS) || 5)
const BOT_UA = 'Mozilla/5.0 (compatible; pakistan-mutual-funds-api; +https://github.com/saadsalmankhan/pakistan-mutual-funds-api)'
// PSX answers some paths with a 404 page unless the client looks like a browser.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0'

async function withRetries<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 3000))
    try {
      return await fn()
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`${what} failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : lastError}`)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function isoShift(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function karachiHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hour12: false }).format(new Date()))
}

// A "latest value" only counts as a close once the session is over: it is
// dated before today, or the run is well after the bell (16:30 PKT at the
// latest, on Fridays).
function isClosed(date: string): boolean {
  return date < karachiDate() || karachiHour() >= 18
}

// --- scstrade: dated history -------------------------------------------------

// "2026-09-20" -> "09/20/2026", the format scstrade's date pickers send
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`

// .NET JSON dates, "/Date(1789930800000)/", stamped at midnight Karachi time
// (19:00 UTC the day before). Shift to PKT (UTC+5, no DST) for the date.
function dotNetDate(text: string): string | null {
  const ms = Number(/\d+/.exec(text)?.[0])
  return ms ? new Date(ms + 5 * 3600 * 1000).toISOString().slice(0, 10) : null
}

async function fetchScstrade(name: string, from: string, to: string): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = []
  // One request per calendar year keeps each response small.
  for (let start = from; start <= to; ) {
    const yearEnd = `${start.slice(0, 4)}-12-31`
    const end = yearEnd < to ? yearEnd : to
    const rows = await withRetries(`scstrade ${name} ${start}..${end}`, async () => {
      const res = await fetch('https://scstrade.com/MarketStatistics/MS_HistoricalIndices.aspx/chart', {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          accept: 'application/json',
          referer: 'https://scstrade.com/MarketStatistics/MS_HistoricalIndices.aspx',
          'user-agent': BOT_UA,
        },
        body: JSON.stringify({ par: SCSTRADE_NAMES[name], date1: usDate(start), date2: usDate(end) }),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { d?: Array<Record<string, unknown>> }
      if (!Array.isArray(body?.d)) throw new Error('response has no rows array')
      return body.d
    })
    for (const row of rows) {
      const date = dotNetDate(String(row.kse_index_date ?? ''))
      const close = Number(row.kse_index_close)
      if (date && close > 0 && date >= start && date <= end) entries.push({ date, close })
    }
    start = isoShift(end, 1)
  }
  return entries
}

// --- psx: official latest close ------------------------------------------------

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

async function fetchPsxLatest(): Promise<{ date: string; values: Record<string, number> }> {
  const html = await withRetries('PSX indices page', async () => {
    const res = await fetch('https://dps.psx.com.pk/indices', {
      headers: { 'user-agent': BROWSER_UA },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  })
  const asOf = /As of\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/.exec(html)
  if (!asOf || !MONTHS[asOf[1]]) throw new Error('PSX indices page has no "As of" date')
  const date = `${asOf[3]}-${MONTHS[asOf[1]]}-${asOf[2].padStart(2, '0')}`
  const values: Record<string, number> = {}
  for (const [name, symbol] of Object.entries(INDICES)) {
    const m = new RegExp(`topIndices__item__name">${symbol}</div>\\s*<div class="topIndices__item__val">([\\d,.]+)<`).exec(html)
    const close = m ? Number(m[1].replace(/,/g, '')) : NaN
    if (close > 0) values[name] = close
  }
  if (!Object.keys(values).length) throw new Error('PSX indices page has no index values (layout changed?)')
  return { date, values }
}

// --- tradingview: undated latest value ----------------------------------------

async function fetchTradingView(): Promise<Record<string, number>> {
  return withRetries('TradingView screener', async () => {
    const res = await gotScraping({
      url: 'https://scanner.tradingview.com/pakistan/scan',
      method: 'POST',
      json: {
        symbols: { tickers: Object.values(INDICES).map(s => `PSX:${s}`) },
        columns: ['close'],
      },
      responseType: 'json',
      timeout: { request: 30000 },
      retry: { limit: 0 },
    })
    const body = res.body as { data?: Array<{ s: string; d: unknown[] }> }
    if (res.statusCode !== 200 || !Array.isArray(body?.data)) throw new Error(`HTTP ${res.statusCode}`)
    const values: Record<string, number> = {}
    for (const [name, symbol] of Object.entries(INDICES)) {
      const row = body.data.find(r => r.s === `PSX:${symbol}`)
      const close = Number(row?.d?.[0])
      if (close > 0) values[name] = Math.round(close * 100) / 100
    }
    if (!Object.keys(values).length) throw new Error('no index values in response')
    return values
  })
}

// --- reconciliation -------------------------------------------------------------

type Candidate = { source: Source; close: number }

export interface Verdict {
  date: string
  status: 'confirmed' | 'single-source' | 'conflict'
  close?: number
  sources: Source[]
  values: Partial<Record<Source, number>>
  spreadPct: number // largest relative gap between any two sources, in %
}

const agree = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= TOLERANCE

// Settle one date from whatever the sources said about it. Two or more that
// agree win; a lone source is taken at its word; sources that all disagree
// settle nothing.
export function reconcile(date: string, candidates: Candidate[]): Verdict {
  const values = Object.fromEntries(candidates.map(c => [c.source, c.close])) as Verdict['values']
  const closes = candidates.map(c => c.close)
  const spreadPct = closes.length > 1
    ? Math.round(((Math.max(...closes) - Math.min(...closes)) / Math.max(...closes)) * 1e6) / 1e4
    : 0
  if (candidates.length === 1) {
    return { date, status: 'single-source', close: candidates[0].close, sources: [candidates[0].source], values, spreadPct }
  }
  let best: Candidate[] = []
  for (const c of candidates) {
    const group = candidates.filter(o => agree(o.close, c.close))
    if (group.length > best.length) best = group
  }
  if (best.length < 2) return { date, status: 'conflict', sources: [], values, spreadPct }
  const official = PRIORITY.map(s => best.find(c => c.source === s)).find(Boolean)!
  const sources = PRIORITY.filter(s => best.some(c => c.source === s))
  return { date, status: 'confirmed', close: official.close, sources, values, spreadPct }
}

export interface IndexStatus {
  checkedAt: string
  sources: Record<Source, { ok: boolean; detail: string }>
  indices: Record<string, { latest: Verdict | null; written: number; singleSourceDays: number }>
  // Days nothing was written for: sources that disagree with each other, or
  // a lone source that disagrees with the close already on file (`stored`).
  conflicts: Array<{ index: string; stored?: number } & Verdict>
}

// Fetch every source, settle every date, merge into the index files.
// Returns how many indices got no close at all (what a retry could fix).
export async function refreshIndices(from: string = isoShift(karachiDate(), -45)): Promise<number> {
  const to = karachiDate()
  const status: IndexStatus = {
    checkedAt: new Date().toISOString(),
    sources: {} as IndexStatus['sources'],
    indices: {},
    conflicts: [],
  }

  const scstrade: Record<string, IndexEntry[]> = {}
  const scstradeErrors: string[] = []
  for (const name of Object.keys(INDICES)) {
    try {
      scstrade[name] = await fetchScstrade(name, from, to)
    } catch (err) {
      scstradeErrors.push(`${name}: ${message(err)}`)
    }
  }
  status.sources.scstrade = scstradeErrors.length
    ? { ok: false, detail: scstradeErrors.join('; ') }
    : { ok: true, detail: `${Object.values(scstrade).reduce((n, e) => n + e.length, 0)} closes ${from}..${to}` }

  // Mid-session, PSX and TradingView answer fine but with live values, not
  // closes. That's not an outage, so they report ok and just don't vote.
  let psx: Awaited<ReturnType<typeof fetchPsxLatest>> | null = null
  // The trading day live values belong to, closed or not. PSX's page states
  // it; without the page, today counts only if scstrade already has today.
  let session: string | null = null
  try {
    const latest = await fetchPsxLatest()
    session = latest.date
    if (isClosed(latest.date)) {
      psx = latest
      status.sources.psx = { ok: true, detail: `closes for ${latest.date}` }
    } else {
      status.sources.psx = { ok: true, detail: `market still open on ${latest.date}: no close to compare yet` }
    }
  } catch (err) {
    status.sources.psx = { ok: false, detail: message(err) }
  }

  let tradingview: Record<string, number> | null = null
  try {
    tradingview = await fetchTradingView()
    status.sources.tradingview = { ok: true, detail: 'latest values' }
  } catch (err) {
    status.sources.tradingview = { ok: false, detail: message(err) }
  }

  let failed = 0
  for (const name of Object.keys(INDICES)) {
    const byDate = new Map<string, Candidate[]>()
    const add = (date: string, c: Candidate) => byDate.set(date, [...(byDate.get(date) ?? []), c])
    for (const e of scstrade[name] ?? []) add(e.date, { source: 'scstrade', close: e.close })
    if (psx?.values[name]) add(psx.date, { source: 'psx', close: psx.values[name] })
    // TradingView carries no date: its value is the current session's, so it
    // votes on that date only, and only once the session is over.
    const day = session ?? (byDate.has(karachiDate()) ? karachiDate() : null)
    if (day && tradingview?.[name] && isClosed(day)) {
      add(day, { source: 'tradingview', close: tradingview[name] })
    }

    if (!byDate.size) {
      failed++
      status.indices[name] = { latest: null, written: 0, singleSourceDays: 0 }
      console.log(`::warning::${name}: no source returned a close`)
      continue
    }

    const stored = new Map((await readIndex(name) ?? []).map(e => [e.date, e]))
    const toWrite: IndexEntry[] = []
    let singleSourceDays = 0
    let latest: Verdict | null = null
    for (const date of [...byDate.keys()].sort()) {
      const verdict = reconcile(date, byDate.get(date)!)
      latest = verdict
      if (verdict.status === 'conflict') {
        status.conflicts.push({ index: name, ...verdict })
        continue
      }
      if (verdict.status === 'single-source') singleSourceDays++
      const close = verdict.close!
      const prev = stored.get(date)
      if (prev && !agree(prev.close, close)) {
        // A stored close is only replaced by a number at least two sources
        // agree on; one source contradicting it is reported instead.
        if (verdict.status !== 'confirmed') {
          status.conflicts.push({ index: name, stored: prev.close, ...verdict, status: 'conflict', sources: [] })
          continue
        }
      } else if (prev && (!prev.sources || prev.sources.length >= verdict.sources.length)) {
        // Already on file and agreeing: rows from before multi-sourcing (no
        // `sources`, served by PSX itself) or at least as well attested.
        continue
      }
      toWrite.push({ date, close, sources: verdict.sources })
    }
    const written = await mergeDated(indexFile(name), toWrite)
    status.indices[name] = { latest, written, singleSourceDays }
    const how = latest
      ? `${latest.status}${latest.sources.length ? ` by ${latest.sources.join('+')}` : ''}, spread ${latest.spreadPct}%`
      : ''
    console.log(`${name}: newest ${latest?.date} ${latest?.close ?? '(unresolved)'} (${how}); ${written} rows written`)
  }

  for (const [source, s] of Object.entries(status.sources)) {
    if (!s.ok) console.log(`::warning::${source} is down: ${s.detail}`)
  }
  for (const c of status.conflicts) {
    const stored = c.stored !== undefined ? `, on file ${c.stored}` : ''
    console.log(`::warning::${c.index} ${c.date}: sources disagree ${JSON.stringify(c.values)}${stored}; nothing written for that day`)
  }

  const statusFile = indexStatusFile()
  await mkdir(dirname(statusFile), { recursive: true })
  await writeFile(statusFile, JSON.stringify(status, null, 1) + '\n', 'utf-8')
  return failed
}

export async function readIndexStatus(): Promise<IndexStatus | null> {
  try {
    return JSON.parse(await readFile(indexStatusFile(), 'utf-8')) as IndexStatus
  } catch {
    return null
  }
}

// Only run when invoked as a script (performance.ts imports INDICES).
if (process.argv[1] && /indices\.(ts|js)$/.test(process.argv[1])) {
  const fromArg = process.argv.find(a => a.startsWith('--from='))?.split('=')[1]
  refreshIndices(fromArg)
    .then(failed => { if (failed) process.exit(1) })
    .catch(e => {
      console.error('ERROR:', e.message)
      process.exit(1)
    })
}
