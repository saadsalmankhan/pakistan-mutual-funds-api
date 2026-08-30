// Scrapes MUFAP's Expense Ratios table (Industry Statistics, tab 5) — a
// server-rendered table keyed by the same FundID as the Fund Directory — and
// stores per-fund metadata (TER YTD %, management fee %, inception date) that
// the directory page doesn't carry. Run via `npm run enrich`; writeStore
// merges the result into every subsequent snapshot. Expense ratios change
// rarely, so running this daily is fine but not required.
import 'dotenv/config'
import * as cheerio from 'cheerio'
import { gotScraping } from 'got-scraping'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MetaFile } from './types.js'

const EXPENSE_RATIOS_URL = 'https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=5'
const META_FILE = process.env.META_FILE || './data/meta.json'
const MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRAPE_ATTEMPTS) || 4)
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.SCRAPE_TIMEOUT_MS) || 45000)

function parsePercent(text: string): number | undefined {
  const n = parseFloat(text.replace(/,/g, '').trim())
  return isNaN(n) ? undefined : n
}

async function fetchExpenseRatiosHtml(): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await gotScraping({
        url: EXPENSE_RATIOS_URL,
        timeout: { request: REQUEST_TIMEOUT_MS },
        retry: { limit: 0 },
      })
      if (res.statusCode === 200 && res.body.includes('fund-block')) {
        return res.body
      }
      lastError = new Error(
        `MUFAP returned HTTP ${res.statusCode} without fund data (likely a Cloudflare challenge)`
      )
    } catch (err) {
      lastError = err
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`MUFAP expense ratios fetch failed after ${MAX_ATTEMPTS} attempts: ${detail}`)
}

export async function scrapeFundMeta(): Promise<MetaFile> {
  const html = await fetchExpenseRatiosHtml()
  const $ = cheerio.load(html)

  // Columns: Sector | AMC | Fund | Category | Inception Date | NAV |
  //          TER MTD % | TER YTD % | MF % | S&M % | Validity Date
  const meta: MetaFile = {}
  $('tr.fund-block').each((_, row) => {
    const $row = $(row)
    const detailHref = $row.find('a[href*="FundDetail?FundID="]').attr('href') ?? ''
    const fundId = detailHref.split('FundID=')[1]
    if (!fundId) return

    const cells = $row.find('td').map((_, td) => $(td).text().trim()).get()
    const inceptionDate = cells[4] || undefined
    const expenseRatio = parsePercent(cells[7] ?? '')
    const managementFee = parsePercent(cells[8] ?? '')

    const entry: Record<string, unknown> = {}
    if (inceptionDate) entry.inceptionDate = inceptionDate
    if (expenseRatio !== undefined) entry.expenseRatio = expenseRatio
    if (managementFee !== undefined) entry.managementFee = managementFee
    if (Object.keys(entry).length) meta[fundId] = entry
  })

  if (Object.keys(meta).length === 0) {
    throw new Error('Parsed zero metadata rows — MUFAP page structure may have changed')
  }
  return meta
}

const meta = await scrapeFundMeta()
await mkdir(dirname(META_FILE), { recursive: true })
await writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf-8')
console.log(`Stored metadata for ${Object.keys(meta).length} funds in ${META_FILE}`)
