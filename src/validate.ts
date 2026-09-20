// Check this API's total returns against MUFAP's own payout-adjusted
// Performance Summary (Industry/IndustryStatDaily?tab=1).
//
//   npm run validate
//
// The claim in the README ("within 1 percentage point of MUFAP's figures")
// should be something anyone can re-run, not something to take on trust.
// Only categories MUFAP labels "Absolute Return" are compared (equity-type
// funds): it annualizes the rest, while this API is cumulative throughout.
// 365 Days, 2 Years and 3 Years line up with 1y/2y/3y; MUFAP's shorter
// windows count days where this API counts calendar months, so they differ
// by construction and are skipped. Funds whose NAV date differs between the
// two sources are skipped too (different end dates, different returns).
import 'dotenv/config'
import * as cheerio from 'cheerio'
import { fetchMufapHtml, parseMufapDate } from './mufap.js'
import { computeReturns } from './returns.js'
import type { Period } from './returns.js'
import { readHistory, readPayouts } from './store.js'

// Cell layout (tab=1): [1] Category [2] Fund [5] Validity Date [7] YTD
// ... [15] 365 Days [16] 2 Years [17] 3 Years. Negatives print as "(8.14)".
const COLUMNS: Array<[Period, number]> = [['fytd', 7], ['1y', 15], ['2y', 16], ['3y', 17]]

function parsePct(text: string | undefined): number | null {
  if (!text || text === 'N/A' || text === '-') return null
  const n = parseFloat(text.replace(/[(),]/g, ''))
  if (isNaN(n)) return null
  return /^\(.*\)$/.test(text.trim()) ? -n : n
}

async function main() {
  const html = await fetchMufapHtml('https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=1', 'performance summary')
  const $ = cheerio.load(html)
  const diffs = new Map<Period, Array<{ name: string; ours: number; theirs: number }>>()
  let skippedDate = 0
  for (const row of $('tr.fund-block').toArray()) {
    const $row = $(row)
    const fundId = ($row.find('a[href*="FundID="]').attr('href') ?? '').split('FundID=')[1]
    const cells = $row.find('td').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim()).get()
    if (!fundId || !/Absolute/i.test(cells[1] ?? '')) continue
    const history = await readHistory(fundId)
    const computed = history && computeReturns(history, await readPayouts(fundId))
    if (!computed) continue
    if (computed.latestDate !== parseMufapDate(cells[5] ?? '')) { skippedDate++; continue }
    for (const [period, col] of COLUMNS) {
      const theirs = parsePct(cells[col])
      const ours = computed.returns[period]
      if (theirs === null || !ours || ours.anomalies > 0) continue
      diffs.set(period, [...(diffs.get(period) ?? []), { name: cells[2], ours: ours.pct, theirs }])
    }
  }
  if (!diffs.size) throw new Error('Nothing to compare — is there history on disk, and is it as fresh as MUFAP?')

  console.log(`Total return vs MUFAP Performance Summary (${skippedDate} funds skipped: NAV dates differ)\n`)
  let worstShare = 100
  for (const [period] of COLUMNS) {
    const list = diffs.get(period) ?? []
    if (!list.length) continue
    const abs = list.map(d => Math.abs(d.ours - d.theirs)).sort((a, b) => a - b)
    const within = (t: number) => Math.round((abs.filter(x => x <= t).length / abs.length) * 100)
    if (period !== '3y') worstShare = Math.min(worstShare, within(1))
    console.log(`${period.padEnd(5)} ${String(list.length).padStart(3)} funds | median gap ${abs[Math.floor(abs.length / 2)].toFixed(2)}pp | within 1pp ${within(1)}% | within 5pp ${within(5)}%`)
    const worst = [...list].sort((a, b) => Math.abs(b.ours - b.theirs) - Math.abs(a.ours - a.theirs))[0]
    if (Math.abs(worst.ours - worst.theirs) > 1) console.log(`        largest: ${worst.name} — ours ${worst.ours}% vs MUFAP ${worst.theirs}%`)
  }
  // Longer windows accumulate rounding and the odd duplicated dividend, so
  // the pass mark is set on the periods that should match almost exactly.
  if (worstShare < 95) {
    console.error(`\nFAIL: under 95% of funds within 1pp on a period up to 2y (${worstShare}%)`)
    process.exit(1)
  }
  console.log('\nOK')
}

main().catch(e => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
