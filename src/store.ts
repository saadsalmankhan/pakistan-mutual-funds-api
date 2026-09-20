import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Fund, FundStore, HistoryEntry, IndexEntry, MetaFile, Payout } from './types.js'

const DATA_FILE = process.env.DATA_FILE || './data/funds.json'
const HISTORY_DIR = process.env.HISTORY_DIR || './data/history'
const META_FILE = process.env.META_FILE || './data/meta.json'
const PAYOUTS_DIR = process.env.PAYOUTS_DIR || './data/payouts'
const INDEX_DIR = process.env.INDEX_DIR || './data/indices'

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
  const enriched = await applyMeta(funds)
  const store: FundStore = { funds: enriched, updatedAt: new Date().toISOString() }
  await mkdir(dirname(DATA_FILE), { recursive: true })
  await writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8')
  await appendHistory(enriched)
  return store
}

// Merge per-fund metadata (expense ratio, management fee, inception date)
// scraped separately by `npm run enrich`. Missing file just means no
// enrichment yet — the snapshot works fine without it.
async function applyMeta(funds: Fund[]): Promise<Fund[]> {
  let meta: MetaFile
  try {
    meta = JSON.parse(await readFile(META_FILE, 'utf-8')) as MetaFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return funds
    throw err
  }
  return funds.map(f => (meta[f.fundId] ? { ...f, ...meta[f.fundId] } : f))
}

// MUFAP doesn't publish a NAV date on the directory page, so live appends key
// history entries by the scrape date in MUFAP's own timezone (Asia/Karachi,
// no DST). A run that drifts past midnight PKT files yesterday's NAV under
// today's date — schedulers that can't guarantee start times (GitHub Actions
// delays cron by hours) should set SKIP_HISTORY=true and merge dated rows via
// `npm run backfill -- --recent=10 --overwrite` instead.
export function karachiDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date())
}

// fundId normally comes from MUFAP's FundID query param, but falls back to the
// fund name when the markup doesn't expose one — keep filenames safe either way.
export function historyFile(fundId: string): string {
  return join(HISTORY_DIR, `${fundId.replace(/[^\w.-]/g, '_').slice(0, 120)}.ndjson`)
}

export function historyDir(): string {
  return HISTORY_DIR
}

// Append today's NAV to each fund's history file. One entry per Karachi date:
// a re-scrape on the same date replaces that day's entry if the values moved
// (MUFAP corrections), and is a no-op otherwise.
async function appendHistory(funds: Fund[]): Promise<void> {
  if (process.env.SKIP_HISTORY === 'true') return
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

const safeName = (id: string) => id.replace(/[^\w.-]/g, '_').slice(0, 120)

export function payoutsFile(fundId: string): string {
  return join(PAYOUTS_DIR, `${safeName(fundId)}.ndjson`)
}

// Index names are stored without punctuation: "KSE-100" -> KSE100.ndjson,
// matching PSX's own symbols.
export function indexFile(name: string): string {
  return join(INDEX_DIR, `${safeName(name.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}.ndjson`)
}

async function readNdjson<T>(file: string): Promise<T[] | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}

// A fund with no payouts file simply never paid out (or payouts were never
// scraped) — both read as an empty list, so returns fall back to NAV change.
export async function readPayouts(fundId: string): Promise<Payout[]> {
  return (await readNdjson<Payout>(payoutsFile(fundId))) ?? []
}

export async function readIndex(name: string, from?: string, to?: string): Promise<IndexEntry[] | null> {
  let entries = await readNdjson<IndexEntry>(indexFile(name))
  if (entries === null) return null
  if (from) entries = entries.filter(e => e.date >= from)
  if (to) entries = entries.filter(e => e.date <= to)
  return entries
}

// Merge dated rows into an NDJSON file, one row per date, result date-sorted.
// Incoming rows replace a same-date row when they differ (the source is the
// authority and republishes corrections). Returns how many rows changed.
export async function mergeDated<T extends { date: string }>(file: string, incoming: T[]): Promise<number> {
  const existing = new Map<string, T>()
  for (const e of (await readNdjson<T>(file)) ?? []) existing.set(e.date, e)
  let changed = 0
  for (const e of incoming) {
    const prev = existing.get(e.date)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(e)) {
      existing.set(e.date, e)
      changed++
    }
  }
  if (!changed) return 0
  const sorted = [...existing.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, sorted.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
  return changed
}
