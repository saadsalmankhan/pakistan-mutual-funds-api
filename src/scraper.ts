import * as cheerio from 'cheerio'
import { gotScraping } from 'got-scraping'
import type { Fund } from './types.js'

// MUFAP's own JSON endpoints (the ones their site's own JS calls, e.g.
// /Home/GetMutualFund) 500 even with browser-identical headers — likely
// requiring some session/anti-forgery state that isn't easy to replicate
// server-side. Their public Fund Directory page, by contrast, is a plain
// server-rendered HTML table with every fund's current NAV already in the
// markup (no auth, no pagination — all ~500+ funds in one response), so
// that's parsed here instead of fighting the broken API.
const FUND_DIRECTORY_URL = 'https://www.mufap.com.pk/FundProfile/FundDirectory'

// MUFAP now sits behind Cloudflare's managed-challenge bot protection, so a
// plain fetch() gets a 403 with `cf-mitigated: challenge` and never sees the
// page. got-scraping impersonates a real browser's TLS fingerprint and header
// order, which Cloudflare serves the real page to — no headless browser, no
// clearance cookies and no configuration required, so a fresh clone just
// works. Cloudflare still challenges the odd request, so we retry a few times
// (got-scraping rotates the fingerprint on each attempt) before giving up.
const MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRAPE_ATTEMPTS) || 4)
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.SCRAPE_TIMEOUT_MS) || 45000)

function parseNumber(text: string): number {
  const n = parseFloat(text.replace(/,/g, '').trim())
  return isNaN(n) ? 0 : n
}

// Fetch the directory HTML, retrying past the occasional Cloudflare challenge.
// Only markup that actually contains fund rows counts as a success; a 200 that
// is really a "Just a moment…" challenge page is treated as a miss and retried.
async function fetchFundDirectoryHtml(): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await gotScraping({
        url: FUND_DIRECTORY_URL,
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
  throw new Error(`MUFAP fund directory fetch failed after ${MAX_ATTEMPTS} attempts: ${detail}`)
}

export async function scrapeMufapFundDirectory(): Promise<Fund[]> {
  const html = await fetchFundDirectoryHtml()
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
      funds.push({ fundId, name, amc, nav, offerPrice, category })
    }
  })

  if (funds.length === 0) throw new Error('Parsed zero funds — MUFAP page structure may have changed')
  return funds
}
