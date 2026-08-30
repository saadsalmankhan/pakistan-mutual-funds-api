import type { HistoryEntry } from './types.js'

export interface PeriodReturn {
  pct: number
  fromDate: string
  fromNav: number
}

export interface FundReturns {
  latestDate: string
  latestNav: number
  returns: {
    '1m': PeriodReturn | null
    '3m': PeriodReturn | null
    ytd: PeriodReturn | null
    '1y': PeriodReturn | null
    sinceTracking: PeriodReturn | null
  }
}

// Calendar-month arithmetic in UTC; JS Date handles month-end overflow by
// spilling into the next month, which only ever moves a cutoff a day or two
// later — acceptable for trailing-return baselines.
function shiftMonths(date: string, months: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.toISOString().slice(0, 10)
}

// Last entry on or before the cutoff date (entries sorted ascending), i.e.
// the most recent NAV that was already published at the period boundary.
function at(entries: HistoryEntry[], cutoff: string): HistoryEntry | null {
  let found: HistoryEntry | null = null
  for (const e of entries) {
    if (e.date <= cutoff) found = e
    else break
  }
  return found
}

// Simple NAV percentage change, rounded to 2 decimals. Not annualized, and
// payouts/dividends are not accounted for (NAV-only data).
function period(latest: HistoryEntry, from: HistoryEntry | null): PeriodReturn | null {
  if (!from || from.nav <= 0 || from.date === latest.date) return null
  return {
    pct: Math.round((latest.nav / from.nav - 1) * 10000) / 100,
    fromDate: from.date,
    fromNav: from.nav,
  }
}

export function computeReturns(history: HistoryEntry[]): FundReturns | null {
  const entries = [...history].sort((a, b) => (a.date < b.date ? -1 : 1))
  if (!entries.length) return null
  const latest = entries[entries.length - 1]
  const prevYearEnd = `${Number(latest.date.slice(0, 4)) - 1}-12-31`
  return {
    latestDate: latest.date,
    latestNav: latest.nav,
    returns: {
      '1m': period(latest, at(entries, shiftMonths(latest.date, 1))),
      '3m': period(latest, at(entries, shiftMonths(latest.date, 3))),
      ytd: period(latest, at(entries, prevYearEnd)),
      '1y': period(latest, at(entries, shiftMonths(latest.date, 12))),
      sinceTracking: period(latest, entries[0]),
    },
  }
}
