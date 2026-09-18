// The MCP server itself: data access, returns math and tool definitions,
// shared by both entry points —
//   index.js   stdio, what `npx pakistan-mutual-funds-mcp` runs locally
//   worker.js  Streamable HTTP on Cloudflare Workers, the hosted connector
//              that claude.ai and ChatGPT add by URL
// Nothing here may touch a Node-only API: it has to run on Workers too.
//
// Zero-setup by default: reads the free public dataset that a GitHub Action
// updates every business day (github.com/saadsalmankhan/pakistan-mutual-funds-data).
// Pass apiBase to read a self-hosted pakistan-mutual-funds-api instance instead.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export const VERSION = '0.2.0'

const RAW = 'https://raw.githubusercontent.com/saadsalmankhan/pakistan-mutual-funds-data/main'
const DATASET_URL = 'https://github.com/saadsalmankhan/pakistan-mutual-funds-data'
const CACHE_MS = 15 * 60 * 1000

// Module-level so it outlives a single request: the hosted connector builds a
// fresh server per request, but a warm Worker isolate keeps this around.
let fundsCache = null
let fundsCacheAt = 0
let fundsCacheKey = null

// --- returns math (mirrors src/returns.ts in the API) ---
function shiftMonths(date, months) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.toISOString().slice(0, 10)
}
function at(entries, cutoff) {
  let found = null
  for (const e of entries) {
    if (e.date <= cutoff) found = e
    else break
  }
  return found
}
function period(latest, from) {
  if (!from || from.nav <= 0 || from.date === latest.date) return null
  return { pct: Math.round((latest.nav / from.nav - 1) * 10000) / 100, fromDate: from.date, fromNav: from.nav }
}
function computeReturns(history) {
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

// Keep last entry per ISO week / per month for compact long-range series
function thin(entries, interval) {
  if (interval === 'daily') return entries
  const keyOf = (date) => {
    if (interval === 'monthly') return date.slice(0, 7)
    const d = new Date(date + 'T00:00:00Z')
    const day = (d.getUTCDay() + 6) % 7
    d.setUTCDate(d.getUTCDate() - day + 3) // ISO week anchor (Thursday)
    return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 4))) / 86400000 + 1) / 7)).padStart(2, '0')}`
  }
  const byKey = new Map()
  for (const e of entries) byKey.set(keyOf(e.date), e) // later entries overwrite
  return [...byKey.values()]
}

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] })
const compact = (f) => ({
  fundId: f.fundId, name: f.name, amc: f.amc, category: f.category,
  nav: f.nav, shariah: f.shariah,
  ...(f.expenseRatio !== undefined ? { expenseRatio: f.expenseRatio } : {}),
})

// Models read tool results far more reliably than server instructions, and an
// unexplained "-6.9% in 3 months" on a money market fund reads as a loss when
// it is really a dividend payout resetting the NAV. So say it in the result.
const RETURNS_NOTE =
  'Simple NAV change: not annualized, dividend payouts excluded. A payout drops the NAV by the amount paid, so a sharp ' +
  'negative figure on a money market, income or other regularly distributing fund usually marks a payout, not a loss. ' +
  'Check get_nav_history for a one-day step down before calling it a loss.'

// Every tool only reads a public dataset. Clients use these hints to skip
// the "allow this action?" prompt they show for tools that might write.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

const mufapUrl = (fundId) => `https://www.mufap.com.pk/FundProfile/FundDetail?FundID=${encodeURIComponent(fundId)}`

// Words people type that the dataset spells differently.
const SYNONYMS = { islamic: 'shariah', sharia: 'shariah', halal: 'shariah', pension: 'vps', etf: 'exchange traded' }

// Rank funds against a free-text query: every word has to appear somewhere
// in the fund's name, AMC or category; name hits rank above the rest.
function searchFunds(funds, query) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(w => SYNONYMS[w] ?? w)
  if (!words.length) return []
  const scored = []
  for (const f of funds) {
    const name = f.name.toLowerCase()
    const rest = `${f.amc} ${f.category} ${f.shariah ? 'shariah' : 'conventional'} ${f.fundId}`.toLowerCase()
    let score = 0
    for (const w of words) {
      if (name.includes(w)) score += 2
      else if (rest.includes(w)) score += 1
      else { score = -1; break }
    }
    if (score > 0) scored.push({ f, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name)).map(s => s.f)
}

/**
 * Build a ready-to-connect MCP server.
 * @param {object}  [opts]
 * @param {string}  [opts.apiBase]      Self-hosted API base URL; omit to read the public dataset.
 * @param {boolean} [opts.chatgptTools] Also register `search` and `fetch`, the two tools ChatGPT
 *                                      requires from a connector for deep research. Generic names,
 *                                      so they stay off in local installs where they'd sit next to
 *                                      an agent's own search/fetch tools.
 * @param {object}  [opts.fetchInit]    Extra init for every upstream fetch (the Worker passes
 *                                      Cloudflare cache settings here).
 */
export function createServer({ apiBase, chatgptTools = false, fetchInit } = {}) {
  const API = apiBase?.replace(/\/$/, '')

  async function fetchJson(url) {
    const res = await fetch(url, fetchInit)
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    return res.json()
  }

  async function getFunds() {
    const key = API ?? RAW
    if (fundsCache && fundsCacheKey === key && Date.now() - fundsCacheAt < CACHE_MS) return fundsCache
    const data = API ? await fetchJson(`${API}/api/funds`) : await fetchJson(`${RAW}/funds.json`)
    // Defense in depth for dataset mode: if the committed snapshot predates a
    // successful enrich run, merge meta.json (TER, management fee, inception)
    // ourselves so agents always see expense ratios when they exist.
    if (!API && data.funds?.length && data.funds.every(f => f.expenseRatio === undefined)) {
      try {
        const meta = await fetchJson(`${RAW}/meta.json`)
        data.funds = data.funds.map(f => (meta[f.fundId] ? { ...f, ...meta[f.fundId] } : f))
      } catch {
        // meta.json missing entirely — serve the snapshot as-is
      }
    }
    fundsCache = data
    fundsCacheAt = Date.now()
    fundsCacheKey = key
    return data
  }

  async function getHistory(fundId) {
    if (API) {
      const data = await fetchJson(`${API}/api/funds/${encodeURIComponent(fundId)}/history`)
      return data.history
    }
    const safe = fundId.replace(/[^\w.-]/g, '_').slice(0, 120)
    const res = await fetch(`${RAW}/history/${safe}.ndjson`, fetchInit)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching history for ${fundId}`)
    const body = await res.text()
    return body.split('\n').filter(Boolean).map(l => JSON.parse(l))
  }

  const server = new McpServer(
    {
      name: 'pakistan-mutual-funds',
      title: 'Pakistan Mutual Funds',
      version: VERSION,
      websiteUrl: 'https://saadsalman.org/blog/free-api-pakistani-mutual-fund-navs',
    },
    {
      instructions:
        'Daily NAVs, NAV history and trailing returns for ~550 Pakistani mutual funds and VPS pension funds, ' +
        'sourced from MUFAP (Mutual Funds Association of Pakistan) and refreshed every business day. ' +
        'Funds are addressed by MUFAP fundId: find it with list_funds (filter by name substring, category, AMC or Shariah status; ' +
        'get_filters lists the exact category and AMC spellings), then call get_fund, get_returns or get_nav_history. ' +
        'All amounts are PKR. Returns are simple NAV change, not annualized, and exclude dividend payouts, so income and ' +
        'money market funds that pay out look flatter than they are. This is data, not investment advice.',
    }
  )

  server.registerTool('list_funds', {
    title: 'List funds',
    description:
      'List Pakistani mutual funds with current NAVs. Filter by category, AMC, name substring, or Shariah compliance. ' +
      'Data is scraped daily from MUFAP (the industry association). ~550 funds total; results are capped by limit.',
    inputSchema: {
      category: z.string().optional().describe('Exact category, case-insensitive, e.g. "Money Market" or "Shariah Compliant Equity"'),
      amc: z.string().optional().describe('Exact Asset Management Company name, case-insensitive'),
      q: z.string().optional().describe('Substring of the fund name, case-insensitive'),
      shariah: z.boolean().optional().describe('true = Shariah-compliant funds only, false = conventional only'),
      limit: z.number().int().min(1).max(600).optional().describe('Max results, default 50'),
    },
    annotations: READ_ONLY,
  }, async ({ category, amc, q, shariah, limit }) => {
    const { funds, updatedAt } = await getFunds()
    let list = funds
    if (category) list = list.filter(f => f.category.toLowerCase() === category.toLowerCase())
    if (amc) list = list.filter(f => f.amc.toLowerCase() === amc.toLowerCase())
    if (q) list = list.filter(f => f.name.toLowerCase().includes(q.toLowerCase()))
    if (shariah !== undefined) list = list.filter(f => f.shariah === shariah)
    const capped = list.slice(0, limit ?? 50)
    return text({ totalMatches: list.length, returned: capped.length, updatedAt, funds: capped.map(compact) })
  })

  server.registerTool('get_fund', {
    title: 'Get fund details',
    description:
      'Full record for one fund by its MUFAP fundId: NAV, offer price, category, Shariah status, benchmark, expense ratio, management fee, inception date. ' +
      'Note: expenseRatio is TER fiscal-year-to-date (Pakistani fiscal year starts July 1), so it resets each July.',
    inputSchema: { fundId: z.string().describe('MUFAP fund id, e.g. "12768" (from list_funds)') },
    annotations: READ_ONLY,
  }, async ({ fundId }) => {
    const { funds, updatedAt } = await getFunds()
    const fund = funds.find(f => f.fundId === fundId)
    if (!fund) return text({ error: `Unknown fundId ${fundId}. Use list_funds to find ids.` })
    return text({ ...fund, updatedAt })
  })

  server.registerTool('get_nav_history', {
    title: 'Get NAV history',
    description:
      'Daily NAV time series for one fund, oldest first. Use interval weekly/monthly for long ranges to keep output compact. ' +
      'Dates are Asia/Karachi business days.',
    inputSchema: {
      fundId: z.string().describe('MUFAP fund id'),
      from: z.string().optional().describe('Inclusive lower bound, YYYY-MM-DD'),
      to: z.string().optional().describe('Inclusive upper bound, YYYY-MM-DD'),
      interval: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Thin the series: last entry per week/month. Default daily.'),
    },
    annotations: READ_ONLY,
  }, async ({ fundId, from, to, interval }) => {
    let history = await getHistory(fundId)
    if (history === null) return text({ error: `No history for fundId ${fundId}` })
    if (from) history = history.filter(e => e.date >= from)
    if (to) history = history.filter(e => e.date <= to)
    const thinned = thin(history, interval ?? 'daily')
    return text({ fundId, interval: interval ?? 'daily', points: thinned.length, history: thinned })
  })

  server.registerTool('get_returns', {
    title: 'Get trailing returns',
    description:
      'Trailing returns for one fund: 1m, 3m, YTD, 1y and sinceTracking. Simple NAV percentage change, not annualized, ' +
      'payouts not included. A period is null when history does not reach back that far.',
    inputSchema: { fundId: z.string().describe('MUFAP fund id') },
    annotations: READ_ONLY,
  }, async ({ fundId }) => {
    const history = await getHistory(fundId)
    if (history === null) return text({ error: `No history for fundId ${fundId}` })
    const result = computeReturns(history)
    if (!result) return text({ error: `No history entries for fundId ${fundId}` })
    return text({ fundId, ...result, note: RETURNS_NOTE })
  })

  server.registerTool('get_filters', {
    title: 'List categories and AMCs',
    description: 'All distinct fund categories and AMC names, for building precise list_funds queries.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => {
    const { funds } = await getFunds()
    return text({
      categories: [...new Set(funds.map(f => f.category))].sort(),
      amcs: [...new Set(funds.map(f => f.amc))].sort(),
    })
  })

  if (chatgptTools) {
    // ChatGPT only uses a connector for deep research and company knowledge
    // if it exposes this exact pair: `search` returning
    // {results: [{id, title, url}]} and `fetch` returning
    // {id, title, text, url, metadata} — each as structuredContent plus the
    // same object JSON-encoded in a single text item.
    // https://developers.openai.com/api/docs/mcp
    const both = (obj) => ({ structuredContent: obj, content: [{ type: 'text', text: JSON.stringify(obj) }] })
    server.registerTool('search', {
      title: 'Search funds',
      description:
        'Search Pakistani mutual funds by free text: fund name, AMC, category, "islamic"/"shariah", or a MUFAP fundId. ' +
        'Returns matching funds as {id, title, url}; pass an id to fetch for the full record, returns and recent NAVs.',
      inputSchema: { query: z.string().describe('Free-text query, e.g. "meezan islamic income" or "money market"') },
      outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) },
      annotations: READ_ONLY,
    }, async ({ query }) => {
      const { funds } = await getFunds()
      const results = searchFunds(funds, query).slice(0, 25).map(f => ({
        id: f.fundId,
        title: `${f.name} (${f.amc}, ${f.category}) NAV PKR ${f.nav}`,
        url: mufapUrl(f.fundId),
      }))
      return both({ results })
    })

    server.registerTool('fetch', {
      title: 'Fetch fund report',
      description:
        'Full report for one fund by the id returned from search (its MUFAP fundId): current NAV, category, Shariah status, ' +
        'benchmark, expense ratio, trailing returns and month-end NAVs for the last year.',
      inputSchema: { id: z.string().describe('Fund id from search results') },
      outputSchema: { id: z.string(), title: z.string(), text: z.string(), url: z.string(), metadata: z.record(z.any()).optional() },
      annotations: READ_ONLY,
    }, async ({ id }) => {
      const { funds, updatedAt } = await getFunds()
      const fund = funds.find(f => f.fundId === id)
      if (!fund) throw new Error(`Unknown fund id ${id}. Use search to find ids.`)
      const history = (await getHistory(id)) ?? []
      const computed = computeReturns(history)
      const pct = (p) => (p ? `${p.pct > 0 ? '+' : ''}${p.pct}% (since ${p.fromDate})` : 'n/a')
      const lines = [
        `${fund.name}`,
        `AMC: ${fund.amc}`,
        `Category: ${fund.category} (${fund.shariah ? 'Shariah compliant' : 'conventional'})`,
        `NAV: PKR ${fund.nav}${computed ? ` as of ${computed.latestDate}` : ''}; offer price PKR ${fund.offerPrice}`,
        fund.benchmark ? `Benchmark: ${fund.benchmark}` : null,
        fund.expenseRatio !== undefined ? `Expense ratio (TER, fiscal year to date from July 1): ${fund.expenseRatio}%` : null,
        fund.managementFee !== undefined ? `Management fee: ${fund.managementFee}%` : null,
        fund.inceptionDate ? `Inception: ${fund.inceptionDate}` : null,
      ].filter(Boolean)
      if (computed) {
        const r = computed.returns
        lines.push(
          '',
          'Trailing returns (simple NAV change, not annualized, payouts excluded):',
          `1 month: ${pct(r['1m'])}`, `3 months: ${pct(r['3m'])}`, `Year to date: ${pct(r.ytd)}`,
          `1 year: ${pct(r['1y'])}`, `Since tracking began: ${pct(r.sinceTracking)}`,
          '',
          'Month-end NAVs, last 12 months:',
          ...thin(history.filter(e => e.date >= shiftMonths(computed.latestDate, 12)), 'monthly').map(e => `${e.date}: ${e.nav}`)
        )
      }
      lines.push('', `Source: MUFAP via ${DATASET_URL} (snapshot ${updatedAt}). Data, not investment advice.`)
      return both({
        id,
        title: fund.name,
        text: lines.join('\n'),
        url: mufapUrl(id),
        metadata: { amc: fund.amc, category: fund.category, shariah: fund.shariah, updatedAt },
      })
    })
  }

  return server
}
