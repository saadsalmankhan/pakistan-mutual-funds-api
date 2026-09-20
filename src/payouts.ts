// Dividend/payout history from MUFAP's Payouts table
// (Industry/IndustryStatDaily?tab=4), stored per fund as NDJSON.
//
//   npm run payouts                    # everything from 2022-01-01
//   npm run payouts -- --from=2019-07-01
//   npm run payouts -- --recent=45     # re-merge the trailing days (daily job)
//
// Why this exists: a payout drops a fund's NAV by the amount paid, so NAV
// change alone badly understates what an investor earned — a stock fund that
// returned +189% over three years shows +16% on raw NAV after two big annual
// dividends. With the payout and the ex-NAV, returns.ts reinvests each payout
// and gets the total return, which is also the only number that can fairly
// be held against a total-return index like the KSE-100.
//
// Without a date range the table only shows each fund's latest payout; with
// one it serves every payout in the range (money market funds pay daily, so
// a year is thousands of rows — hence quarter-sized requests). Rows carry
// their own payout date, so anything MUFAP returns is safe to merge even
// when it strays a day outside the requested range. Re-running is idempotent.
import 'dotenv/config'
import * as cheerio from 'cheerio'
import { fetchMufapHtml, parseMufapDate } from './mufap.js'
import { karachiDate, mergeDated, payoutsFile } from './store.js'
import type { Payout } from './types.js'

const PAUSE_MS = 3000

function parseNumber(text: string): number {
  const n = parseFloat(text.replace(/,/g, '').trim())
  return isNaN(n) ? 0 : n
}

function isoShift(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Calendar-quarter chunks covering [from, to]
function quarterChunks(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = []
  let start = from
  while (start <= to) {
    const d = new Date(start + 'T00:00:00Z')
    const qEnd = new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 0))
    const end = qEnd.toISOString().slice(0, 10)
    chunks.push({ from: start, to: end > to ? to : end })
    start = isoShift(end, 1)
  }
  return chunks
}

// Cell layout (tab=4): [0] Sector [1] AMC [2] Fund [3] Category
// [4] Inception Date [5] Payout (Per Unit) [6] Ex-NAV [7] Payout Date
function parsePayouts(html: string): Map<string, Payout[]> {
  const $ = cheerio.load(html)
  const byFund = new Map<string, Map<string, Payout>>()
  $('tr.fund-block').each((_, row) => {
    const $row = $(row)
    const detailHref = $row.find('a[href*="FundDetail?FundID="]').attr('href') ?? ''
    const fundId = detailHref.split('FundID=')[1]
    if (!fundId) return
    const cells = $row.find('td').map((_, td) => $(td).text().trim()).get()
    const payout = parseNumber(cells[5] ?? '')
    const exNav = parseNumber(cells[6] ?? '')
    const date = parseMufapDate(cells[7] ?? '')
    if (!date || payout <= 0 || exNav <= 0) return
    let dates = byFund.get(fundId)
    if (!dates) byFund.set(fundId, (dates = new Map()))
    // Two payouts on one date (interim + final, say) reinvest at the same
    // ex-NAV, so they collapse into one row with the payouts summed.
    const prev = dates.get(date)
    dates.set(date, prev ? { date, payout: Math.round((prev.payout + payout) * 1e4) / 1e4, exNav: Math.min(prev.exNav, exNav) } : { date, payout, exNav })
  })
  return new Map([...byFund].map(([id, dates]) => [id, [...dates.values()]]))
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}

// Fetch and merge every payout dated from..to. Returns rows added or updated.
export async function refreshPayouts(from: string, to: string = karachiDate()): Promise<number> {
  const chunks = quarterChunks(from, to)
  console.log(`Payouts ${from} -> ${to}: ${chunks.length} request${chunks.length === 1 ? '' : 's'}`)

  let totalChanged = 0
  for (const [i, chunk] of chunks.entries()) {
    process.stdout.write(`[${i + 1}/${chunks.length}] ${chunk.from}_${chunk.to} ... `)
    const url =
      'https://www.mufap.com.pk/Industry/IndustryStatDaily' +
      `?tab=4&AMCId=0&fundId=0&datefrom=${chunk.from}&datetill=${chunk.to}`
    const byFund = parsePayouts(await fetchMufapHtml(url, `payouts ${chunk.from}..${chunk.to}`))
    let rows = 0
    let changed = 0
    for (const [fundId, payouts] of byFund) {
      rows += payouts.length
      changed += await mergeDated(payoutsFile(fundId), payouts)
    }
    totalChanged += changed
    console.log(`${byFund.size} funds, ${rows} payouts, ${changed} added or updated`)
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, PAUSE_MS + Math.random() * 1500))
  }
  console.log(`Done. ${totalChanged} payout rows added or updated.`)
  return totalChanged
}

export function recentPayoutsFrom(days: number): string {
  return isoShift(karachiDate(), -days)
}

// Only run when invoked as a script (the scheduler imports refreshPayouts).
if (process.argv[1] && /payouts\.(ts|js)$/.test(process.argv[1])) {
  const recentDays = Math.floor(Number(arg('recent', '0')))
  const to = arg('to', karachiDate())
  const from = recentDays > 0 ? isoShift(to, -recentDays) : arg('from', '2022-01-01')
  refreshPayouts(from, to).catch(e => {
    console.error('ERROR:', e.message)
    process.exit(1)
  })
}
