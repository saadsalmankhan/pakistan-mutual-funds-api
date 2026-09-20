import type { HistoryEntry, IndexEntry, Payout } from './types.js'

export interface PeriodReturn {
  // Total return %: NAV change with every payout in the window reinvested at
  // its ex-NAV. Equals navPct for a fund that paid nothing in the window.
  pct: number
  // NAV-only % change. Understates any fund that paid out: a payout drops the
  // NAV by the amount paid without the investor losing anything.
  navPct: number
  fromDate: string
  fromNav: number
  payouts: number // payouts reinvested in the window
  // Unexplained one-day NAV level shifts inside the window (see cleanSeries).
  // 0 for almost every fund. When it isn't, pct is still computed at face
  // value but can't be trusted, and league tables leave the fund out.
  anomalies: number
  // The fund's benchmark index over the exact same dates, and the gap in
  // percentage points (pct - benchmarkPct). Null without a benchmark.
  benchmarkPct: number | null
  excessPct: number | null
}

export const PERIODS = ['1m', '3m', '6m', 'ytd', 'fytd', '1y', '2y', '3y', 'sinceTracking'] as const
export type Period = (typeof PERIODS)[number]

export interface FundReturns {
  latestDate: string
  latestNav: number
  benchmark: string | null
  returns: Record<Period, PeriodReturn | null>
}

export interface Benchmark {
  name: string
  entries: IndexEntry[] // sorted ascending by date
}

// An index close this many days older than the date it stands in for is too
// stale to compare against (the index file hasn't been refreshed).
const MAX_INDEX_LAG_DAYS = 7
// Same idea for a fund's own baseline NAV (long weekends and Eid holidays
// can push the last published NAV a week or so before the boundary).
const MAX_BASELINE_LAG_DAYS = 10

// Calendar-month arithmetic in UTC; JS Date handles month-end overflow by
// spilling into the next month, which only ever moves a cutoff a day or two
// later — acceptable for trailing-return baselines.
function shiftMonths(date: string, months: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

// Last entry on or before the cutoff date (entries sorted ascending), i.e.
// the most recent value that was already published at the period boundary.
function at<T extends { date: string }>(entries: T[], cutoff: string): T | null {
  let found: T | null = null
  for (const e of entries) {
    if (e.date <= cutoff) found = e
    else break
  }
  return found
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Pakistan's fiscal year runs July 1 to June 30, and it is the year funds and
// MUFAP report on (MUFAP's "YTD" is fiscal). Baseline is the last NAV of the
// previous fiscal year.
function prevFiscalYearEnd(date: string): string {
  const year = Number(date.slice(0, 4))
  return `${date.slice(5, 7) >= '07' ? year : year - 1}-06-30`
}

// Index % change between two dates, or null when the index doesn't cover
// them (missing file, history too short, or not refreshed recently).
export function indexReturn(entries: IndexEntry[], fromDate: string, toDate: string): number | null {
  const from = at(entries, fromDate)
  const to = at(entries, toDate)
  if (!from || !to || from.close <= 0 || from.date === to.date) return null
  if (daysBetween(from.date, fromDate) > MAX_INDEX_LAG_DAYS || daysBetween(to.date, toDate) > MAX_INDEX_LAG_DAYS) return null
  return round2((to.close / from.close - 1) * 100)
}

// --- Cleaning the source data ---------------------------------------------
// MUFAP's tables are typed in by ~25 asset managers and carry three kinds of
// noise that would each wreck a return if taken at face value:
//
//  1. One-day bad values. A pension scheme's equity and debt sub-fund NAVs
//     transposed for a day, a column of 1.47s on a bad upload. They revert
//     the next day, so they only matter when a period boundary lands on one
//     — drop them (despike).
//  2. Level shifts with no payout behind them. A 10-for-1 unit consolidation
//     moves the NAV 11 -> 110 overnight and would read as +900%; sub-funds
//     of one pension scheme sometimes trade places for a week. But not every
//     such jump is fake — a nearly-redeemed fund can really gain 40% in a day
//     on a provision reversal, and MUFAP's own figures count it. There is no
//     telling the two apart from the numbers, so nothing is rewritten: the
//     shift is recorded as an anomaly, returns over it are computed at face
//     value (as MUFAP does) and flagged, and league tables skip flagged funds.
//  3. Payout dates that trail the NAV drop by a day or three. A window that
//     starts in between would count the payout without the drop. Each
//     sizeable payout is re-dated to the day the NAV actually fell.
//
// Validated against MUFAP's own payout-adjusted Performance Summary
// (`npm run validate`; Sep 2026, 116-140 funds per period): 1y and 2y
// figures within 1 percentage point for every fund, 3y within 1 point for
// 93% and within 5 for 99%. The one large gap is a fund whose 2024 dividend
// MUFAP lists (and counts) twice.

const SPIKE_DEVIATION = 0.3 // off its neighbours by more than this...
const SPIKE_NEIGHBOUR_AGREEMENT = 0.15 // ...while they agree with each other
const LEVEL_SHIFT = 0.35
const MAX_SHIFT_GAP_DAYS = 10 // a long gap can hold a real 35% move
const ALIGN_MIN_YIELD = 0.02 // only payouts big enough to see in the NAV

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

function despike(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.filter((e, i) => {
    const before = entries.slice(Math.max(0, i - 3), i).map(x => x.nav)
    const after = entries.slice(i + 1, i + 4).map(x => x.nav)
    if (!before.length || !after.length) return true
    const b = median(before)
    const a = median(after)
    if (b <= 0 || a <= 0 || Math.abs(a / b - 1) > SPIKE_NEIGHBOUR_AGREEMENT) return true
    return Math.abs(e.nav / b - 1) <= SPIKE_DEVIATION
  })
}

export interface CleanSeries {
  entries: HistoryEntry[] // sorted ascending, spikes removed
  payouts: Payout[] // re-dated to the NAV-drop day, exact duplicates removed
  anomalies: Array<{ date: string; ratio: number }> // unexplained level shifts
}

export function cleanSeries(history: HistoryEntry[], payouts: Payout[]): CleanSeries {
  const entries = despike([...history].filter(e => e.nav > 0).sort((a, b) => (a.date < b.date ? -1 : 1)))

  const aligned: Payout[] = []
  for (const p of [...payouts].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (!(p.payout > 0) || !(p.exNav > 0)) continue
    let date = p.date
    if (p.payout / p.exNav >= ALIGN_MIN_YIELD) {
      let bestDrop = 0
      for (let i = 1; i < entries.length; i++) {
        const offset = daysBetween(p.date, entries[i].date)
        if (offset < -7) continue
        if (offset > 3) break
        const drop = entries[i - 1].nav - entries[i].nav
        if (drop >= 0.5 * p.payout && drop > bestDrop) {
          bestDrop = drop
          date = entries[i].date
        }
      }
      // MUFAP sometimes lists one dividend twice under adjacent dates.
      if (aligned.some(q => q.date === date && q.payout === p.payout && q.exNav === p.exNav)) continue
    }
    aligned.push({ ...p, date })
  }

  const payoutDates = new Set(aligned.map(p => p.date))
  const anomalies: CleanSeries['anomalies'] = []
  for (let i = 1; i < entries.length; i++) {
    const ratio = entries[i].nav / entries[i - 1].nav
    if (Math.abs(ratio - 1) <= LEVEL_SHIFT) continue
    if (daysBetween(entries[i - 1].date, entries[i].date) > MAX_SHIFT_GAP_DAYS) continue
    if (ratio < 1 && payoutDates.has(entries[i].date)) continue // a recorded payout explains it
    anomalies.push({ date: entries[i].date, ratio: Math.round(ratio * 100) / 100 })
  }
  return { entries, payouts: aligned, anomalies }
}

// Growth factor from reinvesting payouts: each one buys payout/exNav more
// units per unit held. The NAV on a payout's date is already ex-payout, so
// it belongs to the window when fromDate < date <= toDate.
function windowFactor(series: CleanSeries, fromDate: string, toDate: string) {
  let factor = 1
  let payouts = 0
  for (const p of series.payouts) {
    if (p.date > fromDate && p.date <= toDate) {
      factor *= 1 + p.payout / p.exNav
      payouts++
    }
  }
  const anomalies = series.anomalies.filter(a => a.date > fromDate && a.date <= toDate).length
  return { factor, payouts, anomalies }
}

function period(
  latest: HistoryEntry,
  from: HistoryEntry | null,
  series: CleanSeries,
  benchmark: Benchmark | undefined
): PeriodReturn | null {
  if (!from || from.nav <= 0 || from.date === latest.date) return null
  const navGrowth = latest.nav / from.nav
  const { factor, payouts, anomalies } = windowFactor(series, from.date, latest.date)
  const pct = round2((navGrowth * factor - 1) * 100)
  const benchmarkPct = benchmark ? indexReturn(benchmark.entries, from.date, latest.date) : null
  return {
    pct,
    navPct: round2((navGrowth - 1) * 100),
    fromDate: from.date,
    fromNav: from.nav,
    payouts,
    anomalies,
    benchmarkPct,
    excessPct: benchmarkPct === null ? null : round2(pct - benchmarkPct),
  }
}

// Trailing returns for one fund. Cumulative, never annualized. `sinceTracking`
// starts at the first NAV on file, not at the fund's inception.
export function computeReturns(
  history: HistoryEntry[],
  payouts: Payout[] = [],
  benchmark?: Benchmark
): FundReturns | null {
  const series = cleanSeries(history, payouts)
  const entries = series.entries
  if (!entries.length) return null
  const latest = entries[entries.length - 1]
  // A baseline has to sit close to its boundary: a fund that went quiet for
  // months would otherwise have a "1 year" return measured over 18.
  const baseline = (cutoff: string) => {
    const e = at(entries, cutoff)
    return e && daysBetween(e.date, cutoff) <= MAX_BASELINE_LAG_DAYS ? e : null
  }
  const back = (months: number) => baseline(shiftMonths(latest.date, months))
  const baselines: Record<Period, HistoryEntry | null> = {
    '1m': back(1),
    '3m': back(3),
    '6m': back(6),
    ytd: baseline(`${Number(latest.date.slice(0, 4)) - 1}-12-31`),
    fytd: baseline(prevFiscalYearEnd(latest.date)),
    '1y': back(12),
    '2y': back(24),
    '3y': back(36),
    sinceTracking: entries[0],
  }
  const returns = {} as Record<Period, PeriodReturn | null>
  for (const p of PERIODS) returns[p] = period(latest, baselines[p], series, benchmark)
  return { latestDate: latest.date, latestNav: latest.nav, benchmark: benchmark?.name ?? null, returns }
}
