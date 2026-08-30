import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Fund, FundStore, HistoryEntry } from './types.js'

const DATA_FILE = process.env.DATA_FILE || './data/funds.json'
const HISTORY_DIR = process.env.HISTORY_DIR || './data/history'

export async function readStore(): Promise<FundStore | null> {
  try {
    const raw = await readFile(DATA_FILE, 'utf-8')
    return JSON.parse(raw) as FundStore
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeStore(funds: Fund[]): Promise<FundStore> {
  const store: FundStore = { funds, updatedAt: new Date().toISOString() }
  await mkdir(dirname(DATA_FILE), { recursive: true })
  await writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8')
  await appendHistory(funds)
  return store
}

// MUFAP doesn't publish a NAV date on the directory page, so history entries
// are keyed by the scrape date in MUFAP's own timezone (Asia/Karachi, no DST).
function karachiDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date())
}

// fundId normally comes from MUFAP's FundID query param, but falls back to the
// fund name when the markup doesn't expose one — keep filenames safe either way.
function historyFile(fundId: string): string {
  return join(HISTORY_DIR, `${fundId.replace(/[^\w.-]/g, '_').slice(0, 120)}.ndjson`)
}

// Append today's NAV to each fund's history file. One entry per Karachi date:
// a re-scrape on the same date replaces that day's entry if the values moved
// (MUFAP corrections), and is a no-op otherwise.
async function appendHistory(funds: Fund[]): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true })
  const today = karachiDate()
  for (const fund of funds) {
    const entry: HistoryEntry = { date: today, nav: fund.nav, offerPrice: fund.offerPrice }
    const file = historyFile(fund.fundId)
    let lines: string[]
    try {
      lines = (await readFile(file, 'utf-8')).split('\n').filter(Boolean)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      lines = []
    }
    const last = lines.length ? (JSON.parse(lines[lines.length - 1]) as HistoryEntry) : null
    if (last?.date === today) {
      if (last.nav === entry.nav && last.offerPrice === entry.offerPrice) continue
      lines[lines.length - 1] = JSON.stringify(entry)
      await writeFile(file, lines.join('\n') + '\n', 'utf-8')
    } else {
      await appendFile(file, JSON.stringify(entry) + '\n', 'utf-8')
    }
  }
}

export async function readHistory(
  fundId: string,
  from?: string,
  to?: string
): Promise<HistoryEntry[] | null> {
  let raw: string
  try {
    raw = await readFile(historyFile(fundId), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let entries = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as HistoryEntry)
  if (from) entries = entries.filter(e => e.date >= from)
  if (to) entries = entries.filter(e => e.date <= to)
  return entries
}
