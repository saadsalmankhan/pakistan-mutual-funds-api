// Who beat the market after fees: every fund's payout-reinvested returns next
// to its benchmark index over the same dates.
//
//   npm run performance      # write PERFORMANCE_FILE (./data/performance.json)
//
// The server builds the same table on demand for /api/performance; the file
// exists so a static consumer (the public dataset, the hosted MCP connector)
// gets the whole league table in one fetch instead of ~1,100 file reads.
//
// Fund returns are net of fees by construction (fees come out of the NAV), so
// fund minus index IS the value a manager added or lost after charging for it.
// Two caveats worth carrying wherever the numbers go: funds that closed or
// merged are not in MUFAP's directory, so the table flatters the industry
// (survivorship bias); and an index is not investable at zero cost.
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { computeReturns, indexReturn, PERIODS } from './returns.js'
import type { Benchmark, Period, PeriodReturn } from './returns.js'
import { INDICES } from './indices.js'
import { inferBenchmark, isPassive } from './scraper.js'
import { readHistory, readIndex, readPayouts, readStore } from './store.js'
import type { FundStore } from './types.js'

const PERFORMANCE_FILE = process.env.PERFORMANCE_FILE || './data/performance.json'
// A fund whose latest NAV is this far behind the newest one has stopped
// reporting (closed, merged, suspended). Kept in the file, flagged, and left
// out of league tables.
const STALE_DAYS = 7

export type PeriodRow = Omit<PeriodReturn, 'fromNav'>

export interface PerformanceRow {
  fundId: string
  name: string
  amc: string
  category: string
  shariah: boolean
  benchmark: string | null
  // Index trackers and ETFs: built to match an index, not to beat it.
  passive: boolean
  expenseRatio?: number
  managementFee?: number
  asOf: string
  stale: boolean
  returns: Record<Period, PeriodRow | null>
}

export interface PerformanceFile {
  generatedAt: string
  asOf: string // newest NAV date across all funds
  note: string
  benchmarks: Record<string, { asOf: string; close: number; returns: Record<Period, number | null> }>
  funds: PerformanceRow[]
}

export const PERFORMANCE_NOTE =
  'pct is total return: NAV change with payouts reinvested at the ex-NAV, net of fund fees, cumulative (not annualized). ' +
  'navPct is NAV-only change. benchmarkPct is the fund\'s benchmark index (KSE-100 for conventional equity, KMI-30 for ' +
  'Shariah equity; both total-return indices) over the same dates, excessPct = pct - benchmarkPct in percentage points. ' +
  'anomalies counts unexplained one-day NAV level shifts in the window (unit consolidations, source-data errors); such ' +
  'a return is unverified and league tables leave the fund out. Closed and merged funds are absent, so aggregates ' +
  'flatter the industry. Data, not investment advice.'

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)

export async function loadBenchmarks(): Promise<Map<string, Benchmark>> {
  const out = new Map<string, Benchmark>()
  for (const name of Object.keys(INDICES)) {
    const entries = await readIndex(name)
    if (entries?.length) out.set(name, { name, entries })
  }
  return out
}

export async function buildPerformance(store: FundStore): Promise<PerformanceFile> {
  const benchmarks = await loadBenchmarks()
  const rows: PerformanceRow[] = []
  for (const fund of store.funds) {
    const history = await readHistory(fund.fundId)
    if (!history?.length) continue
    const payouts = await readPayouts(fund.fundId)
    // Re-inferred rather than read off the snapshot, so a snapshot written
    // by an older scraper still gets today's benchmark rules.
    const benchmark = inferBenchmark(fund.category, fund.shariah, fund.name)
    const computed = computeReturns(history, payouts, benchmark ? benchmarks.get(benchmark) : undefined)
    if (!computed) continue
    const returns = {} as Record<Period, PeriodRow | null>
    for (const p of PERIODS) {
      const r = computed.returns[p]
      if (!r) { returns[p] = null; continue }
      const { fromNav: _fromNav, ...rest } = r
      returns[p] = rest
    }
    rows.push({
      fundId: fund.fundId,
      name: fund.name,
      amc: fund.amc,
      category: fund.category,
      shariah: fund.shariah,
      benchmark,
      passive: isPassive(fund.category),
      ...(fund.expenseRatio !== undefined ? { expenseRatio: fund.expenseRatio } : {}),
      ...(fund.managementFee !== undefined ? { managementFee: fund.managementFee } : {}),
      asOf: computed.latestDate,
      stale: false,
      returns,
    })
  }
  const asOf = rows.reduce((max, r) => (r.asOf > max ? r.asOf : max), '')
  for (const r of rows) r.stale = daysBetween(r.asOf, asOf) > STALE_DAYS

  // The indices' own trailing returns, measured to the dataset's as-of date
  // with the same period boundaries funds use.
  const indexReturns: PerformanceFile['benchmarks'] = {}
  for (const [name, b] of benchmarks) {
    const pseudo = computeReturns(b.entries.filter(e => e.date <= asOf).map(e => ({ date: e.date, nav: e.close, offerPrice: e.close })))
    if (!pseudo) continue
    const returns = {} as Record<Period, number | null>
    for (const p of PERIODS) returns[p] = pseudo.returns[p]?.navPct ?? null
    indexReturns[name] = { asOf: pseudo.latestDate, close: pseudo.latestNav, returns }
  }
  return { generatedAt: new Date().toISOString(), asOf, note: PERFORMANCE_NOTE, benchmarks: indexReturns, funds: rows }
}

export interface LeagueQuery {
  period: Period
  category?: string
  amc?: string
  q?: string
  shariah?: boolean
  // Hold every selected fund against this index instead of its own benchmark
  // (e.g. "did any balanced fund keep up with the KSE-100?").
  benchmark?: string
  // 'active' (default) leaves out index trackers and ETFs, whose job is to
  // match the index; 'passive' shows only those (their gap is tracking
  // difference); 'all' shows both.
  style?: 'active' | 'passive' | 'all'
  includeStale?: boolean
  // Include funds whose window holds an unexplained NAV level shift.
  includeFlagged?: boolean
}

export interface LeagueRow {
  fundId: string
  name: string
  amc: string
  category: string
  shariah: boolean
  benchmark: string
  passive: boolean
  expenseRatio?: number
  pct: number
  navPct: number
  benchmarkPct: number
  excessPct: number
  beatBenchmark: boolean
  anomalies: number
  fromDate: string
  asOf: string
}

const round2 = (n: number) => Math.round(n * 100) / 100
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return round2(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}
const mean = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null)

// Filter the table down to funds that can be held against a benchmark for the
// period, best excess return first. Works on a PerformanceFile so it serves
// the live API and a downloaded performance.json alike.
export function leagueTable(perf: PerformanceFile, query: LeagueQuery, override?: Benchmark): LeagueRow[] {
  const category = query.category?.toLowerCase()
  const amc = query.amc?.toLowerCase()
  const q = query.q?.toLowerCase()
  const style = query.style ?? 'active'
  const rows: LeagueRow[] = []
  for (const f of perf.funds) {
    if (f.stale && !query.includeStale) continue
    if (style !== 'all' && f.passive !== (style === 'passive')) continue
    if (category && f.category.toLowerCase() !== category) continue
    if (amc && f.amc.toLowerCase() !== amc) continue
    if (q && !f.name.toLowerCase().includes(q)) continue
    if (query.shariah !== undefined && f.shariah !== query.shariah) continue
    const r = f.returns[query.period]
    if (!r) continue
    if (r.anomalies > 0 && !query.includeFlagged) continue
    const benchmark = override ? override.name : f.benchmark
    const benchmarkPct = override ? indexReturn(override.entries, r.fromDate, f.asOf) : r.benchmarkPct
    if (!benchmark || benchmarkPct === null) continue
    const excessPct = round2(r.pct - benchmarkPct)
    rows.push({
      fundId: f.fundId, name: f.name, amc: f.amc, category: f.category, shariah: f.shariah, benchmark,
      passive: f.passive,
      ...(f.expenseRatio !== undefined ? { expenseRatio: f.expenseRatio } : {}),
      pct: r.pct, navPct: r.navPct, benchmarkPct, excessPct, beatBenchmark: excessPct > 0,
      anomalies: r.anomalies, fromDate: r.fromDate, asOf: f.asOf,
    })
  }
  return rows.sort((a, b) => b.excessPct - a.excessPct)
}

export function summarize(rows: LeagueRow[]) {
  const beat = rows.filter(r => r.beatBenchmark).length
  return {
    funds: rows.length,
    beatBenchmark: beat,
    beatBenchmarkPct: rows.length ? round2((beat / rows.length) * 100) : null,
    medianPct: median(rows.map(r => r.pct)),
    medianExcessPct: median(rows.map(r => r.excessPct)),
    avgExpenseRatio: mean(rows.flatMap(r => (r.expenseRatio !== undefined ? [r.expenseRatio] : []))),
  }
}

// The same table rolled up per asset manager, best average excess first.
export function amcTable(rows: LeagueRow[]) {
  const byAmc = new Map<string, LeagueRow[]>()
  for (const r of rows) byAmc.set(r.amc, [...(byAmc.get(r.amc) ?? []), r])
  return [...byAmc]
    .map(([amc, list]) => ({
      amc,
      ...summarize(list),
      avgExcessPct: mean(list.map(r => r.excessPct)),
      best: { fundId: list[0].fundId, name: list[0].name, excessPct: list[0].excessPct },
      worst: { fundId: list[list.length - 1].fundId, name: list[list.length - 1].name, excessPct: list[list.length - 1].excessPct },
    }))
    .sort((a, b) => (b.avgExcessPct ?? 0) - (a.avgExcessPct ?? 0))
}

async function main() {
  const store = await readStore()
  if (!store) throw new Error('No fund snapshot yet — run `npm run scrape` first')
  const perf = await buildPerformance(store)
  await mkdir(dirname(PERFORMANCE_FILE), { recursive: true })
  await writeFile(PERFORMANCE_FILE, JSON.stringify(perf), 'utf-8')
  const league = leagueTable(perf, { period: '1y' })
  const s = summarize(league)
  console.log(`Stored performance for ${perf.funds.length} funds as of ${perf.asOf} in ${PERFORMANCE_FILE}`)
  console.log(`1y vs own benchmark: ${s.beatBenchmark} of ${s.funds} funds beat it (${s.beatBenchmarkPct}%), median excess ${s.medianExcessPct}pp`)
}

// Only run when invoked as a script (server.ts imports the builders).
if (process.argv[1] && /performance\.(ts|js)$/.test(process.argv[1])) {
  main().catch(e => {
    console.error('ERROR:', e.message)
    process.exit(1)
  })
}
