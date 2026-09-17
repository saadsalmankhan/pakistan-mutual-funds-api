import * as cheerio from 'cheerio'
import { fetchMufapHtml } from './mufap.js'
import type { Fund } from './types.js'

// MUFAP's own JSON endpoints (the ones their site's own JS calls, e.g.
// /Home/GetMutualFund) 500 even with browser-identical headers — likely
// requiring some session/anti-forgery state that isn't easy to replicate
// server-side. Their public Fund Directory page, by contrast, is a plain
// server-rendered HTML table with every fund's current NAV already in the
// markup (no auth, no pagination — all ~500+ funds in one response), so
// that's parsed here instead of fighting the broken API.
const FUND_DIRECTORY_URL = 'https://www.mufap.com.pk/FundProfile/FundDirectory'

function parseNumber(text: string): number {
  const n = parseFloat(text.replace(/,/g, '').trim())
  return isNaN(n) ? 0 : n
}

// MUFAP encodes Shariah status directly in the category name ("Shariah
// Compliant Equity", "VPS-Shariah Compliant Debt", ...).
function isShariah(category: string): boolean {
  return category.includes('Shariah Compliant')
}

// Benchmark mapping for equity-bearing categories only: conventional equity
// tracks KSE-100, Shariah equity tracks KMI-30. Mixed-mandate categories
// (Balanced, Asset Allocation) and fixed-income/money-market funds get null —
// no single index honestly describes them.
const EQUITY_CATEGORIES = new Set([
  'Equity', 'Dedicated Equity', 'Index Tracker', 'Exchange Traded Fund', 'VPS-Equity',
])
function inferBenchmark(category: string, shariah: boolean): string | null {
  const base = category.replace('Shariah Compliant ', '').replace('VPS-Shariah Compliant ', 'VPS-')
  if (!EQUITY_CATEGORIES.has(base)) return null
  return shariah ? 'KMI-30' : 'KSE-100'
}

export async function scrapeMufapFundDirectory(): Promise<Fund[]> {
  const html = await fetchMufapHtml(FUND_DIRECTORY_URL, 'fund directory')
  const $ = cheerio.load(html)

  const funds: Fund[] = []
  $('tr.fund-block').each((_, row) => {
    const $row = $(row)
    const name = $row.find('.card-title').first().text().replace(/\s+/g, ' ').trim()
    if (!name) return

    const amc = $row.find('.card-title').first().parent().find('span').first().text().trim()
    const values = $row.find('.investmentCard p[style*="font-weight: 700"]')
    const nav = parseNumber($(values.get(0)).text())
    const offerPrice = parseNumber($(values.get(1)).text())
    const category = $(values.get(2)).text().trim()

    const detailHref = $row.find('a[href*="FundDetail?FundID="]').attr('href') ?? ''
    const fundId = detailHref.split('FundID=')[1] ?? name

    if (nav > 0) {
      const shariah = isShariah(category)
      const benchmark = inferBenchmark(category, shariah)
      funds.push({ fundId, name, amc, nav, offerPrice, category, shariah, benchmark })
    }
  })

  if (funds.length === 0) throw new Error('Parsed zero funds — MUFAP page structure may have changed')
  return funds
}
