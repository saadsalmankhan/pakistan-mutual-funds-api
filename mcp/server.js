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

export const VERSION = '0.3.0'

const DEFAULT_DATASET = 'https://raw.githubusercontent.com/saadsalmankhan/pakistan-mutual-funds-data/main'
const DATASET_URL = 'https://github.com/saadsalmankhan/pakistan-mutual-funds-data'
const CACHE_MS = 15 * 60 * 1000

// Module-level so it outlives a single request: the hosted connector builds a
// fresh server per request, but a warm Worker isolate keeps this around.
let fundsCache = null
let fundsCacheAt = 0
let fundsCacheKey = null
let perfCache = null
let perfCacheAt = 0
const indexCache = new Map()

const PERIODS = ['1m', '3m', '6m', 'ytd', 'fytd', '1y', '2y', '3y', 'sinceTracking']
const BENCHMARKS = { 'KSE-100': 'KSE100', 'KMI-30': 'KMI30' }

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

// Models read tool results far more reliably than server instructions, so
// the methodology travels with the numbers.
const RETURNS_NOTE =
  'pct is total return: NAV change with payouts reinvested at the ex-NAV, net of fund fees, cumulative (not annualized). ' +
  'navPct is NAV-only change and understates any fund that paid out. benchmarkPct is the benchmark index (KSE-100 for ' +
  'conventional equity, KMI-30 for Shariah equity; both total-return indices) over the same dates; excessPct = pct - ' +
  'benchmarkPct in percentage points. anomalies > 0 means the window holds an unexplained NAV level shift and the return ' +
  'is unverified. Data, not investment advice.'
// Fallback when the dataset has no performance.json (an older mirror): all we
// can compute here is NAV change, and that needs a louder warning.
const NAV_ONLY_NOTE =
  'NAV-only change: not annualized, dividend payouts EXCLUDED. A payout drops the NAV by the amount paid, so a sharp ' +
  'negative figure on a distributing fund usually marks a payout, not a loss.'
const LEAGUE_NOTE =
  'Fund returns are net of fees, so excessPct is what the manager added or lost after charging for it. Closed and merged ' +
  'funds are absent from the source, so the share of funds beating the index is flattered (survivorship bias). ' +
  'expenseRatio is TER, fiscal year to date. ' + RETURNS_NOTE

const round2 = (n) => Math.round(n * 100) / 100
const medianOf = (xs) => {
  if (!xs.length) return null
  const v = [...xs].sort((a, b) => a - b)
  return round2(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2)
}
const meanOf = (xs) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null)

function summarize(rows) {
  const beat = rows.filter(r => r.excessPct > 0).length
  return {
    funds: rows.length,
    beatBenchmark: beat,
    beatBenchmarkPct: rows.length ? round2((beat / rows.length) * 100) : null,
    medianPct: medianOf(rows.map(r => r.pct)),
    medianExcessPct: medianOf(rows.map(r => r.excessPct)),
    avgExpenseRatio: meanOf(rows.flatMap(r => (r.expenseRatio !== undefined ? [r.expenseRatio] : []))),
  }
}

// Index % change between two dates from [{date, close}] sorted ascending.
function indexReturn(entries, fromDate, toDate) {
  const at = (cutoff) => { let f = null; for (const e of entries) { if (e.date <= cutoff) f = e; else break } return f }
  const from = at(fromDate)
  const to = at(toDate)
  if (!from || !to || from.close <= 0 || from.date === to.date) return null
  return round2((to.close / from.close - 1) * 100)
}

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
 * @param {string}  [opts.datasetBase]  Base URL of a dataset mirror or fork (raw file host); defaults
 *                                      to the public pakistan-mutual-funds-data repo.
 * @param {boolean} [opts.chatgptTools] Also register `search` and `fetch`, the two tools ChatGPT
 *                                      requires from a connector for deep research. Generic names,
 *                                      so they stay off in local installs where they'd sit next to
 *                                      an agent's own search/fetch tools.
 * @param {object}  [opts.fetchInit]    Extra init for every upstream fetch (the Worker passes
 *                                      Cloudflare cache settings here).
 */
export function createServer({ apiBase, datasetBase, chatgptTools = false, fetchInit } = {}) {
  const API = apiBase?.replace(/\/$/, '')
  const RAW = (datasetBase || DEFAULT_DATASET).replace(/\/$/, '')

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

  // The precomputed league table (dataset mode): every fund's total returns
  // next to its benchmark, in one file. null when the mirror doesn't have it.
  async function getPerformance() {
    if (perfCache && Date.now() - perfCacheAt < CACHE_MS) return perfCache
    const res = await fetch(`${RAW}/performance.json`, fetchInit)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching performance.json`)
    perfCache = await res.json()
    perfCacheAt = Date.now()
    return perfCache
  }

  async function getIndex(name) {
    const hit = indexCache.get(name)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries
    const res = await fetch(`${RAW}/indices/${BENCHMARKS[name]}.ndjson`, fetchInit)
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${name} history`)
    const entries = (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
    indexCache.set(name, { entries, at: Date.now() })
    return entries
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
        'For "which funds or asset managers beat the market", "is this fund worth its fees" or any fund-vs-index question use ' +
        'get_performance, which ranks funds by total return in excess of their benchmark (KSE-100 or KMI-30). ' +
        'All amounts are PKR. Returns are payout-reinvested total returns, net of fees, cumulative and not annualized. ' +
        'This is data, not investment advice.',
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

  // Total returns for one fund: from the API when self-hosted, else from the
  // dataset's performance.json, else (old mirror) NAV-only from raw history.
  async function fundReturns(fundId) {
    if (API) return fetchJson(`${API}/api/funds/${encodeURIComponent(fundId)}/returns`)
    const row = (await getPerformance())?.funds.find(f => f.fundId === fundId)
    if (row) return { fundId, latestDate: row.asOf, benchmark: row.benchmark, returns: row.returns, note: RETURNS_NOTE }
    const history = await getHistory(fundId)
    const result = history && computeReturns(history)
    return result ? { fundId, ...result, note: NAV_ONLY_NOTE } : null
  }

  server.registerTool('get_returns', {
    title: 'Get trailing returns',
    description:
      'Trailing total returns for one fund (1m, 3m, 6m, YTD, fiscal YTD, 1y, 2y, 3y, sinceTracking) with dividend payouts ' +
      'reinvested, next to its benchmark index (KSE-100 or KMI-30) over the same dates and the gap between them. ' +
      'Cumulative, not annualized. A period is null when history does not reach back that far.',
    inputSchema: { fundId: z.string().describe('MUFAP fund id') },
    annotations: READ_ONLY,
  }, async ({ fundId }) => {
    const result = await fundReturns(fundId)
    if (!result) return text({ error: `No history for fundId ${fundId}` })
    return text(result)
  })

  server.registerTool('get_performance', {
    title: 'Who beat the market',
    description:
      'League table of funds against the stock market after fees: each fund\'s total return next to its benchmark index ' +
      '(KSE-100 for conventional equity, KMI-30 for Shariah equity) over the same dates, ranked by the gap. Use it for ' +
      '"which funds beat the KSE-100", "which asset managers earn their fees", "how many equity funds underperform". ' +
      'Returns a summary (how many funds beat the benchmark, median gap, average expense ratio) plus the ranked funds, ' +
      'or one row per asset manager with groupBy "amc". By default only actively managed funds that have an equity ' +
      'benchmark are listed; pass benchmark to hold any category (balanced, asset allocation...) against an index.',
    inputSchema: {
      period: z.enum(PERIODS).optional().describe('Default 1y. fytd = Pakistani fiscal year to date (from June 30)'),
      category: z.string().optional().describe('Exact category, case-insensitive, e.g. "Equity" or "Shariah Compliant Equity"'),
      amc: z.string().optional().describe('Exact Asset Management Company name, case-insensitive'),
      shariah: z.boolean().optional().describe('true = Shariah-compliant funds only, false = conventional only'),
      style: z.enum(['active', 'passive', 'all']).optional().describe('Default active. passive = index trackers and ETFs, whose gap is tracking difference'),
      benchmark: z.enum(['KSE-100', 'KMI-30']).optional().describe('Hold every selected fund against this index instead of its own benchmark'),
      groupBy: z.enum(['fund', 'amc']).optional().describe('Default fund. amc rolls the table up per asset manager'),
      order: z.enum(['best', 'worst']).optional().describe('Default best (largest excess return first)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows, default 15'),
    },
    annotations: READ_ONLY,
  }, async ({ period = '1y', category, amc, shariah, style = 'active', benchmark, groupBy = 'fund', order = 'best', limit = 15 }) => {
    let rows, asOf, benchmarks
    if (API) {
      const qs = new URLSearchParams({ period, style })
      if (category) qs.set('category', category)
      if (amc) qs.set('amc', amc)
      if (shariah !== undefined) qs.set('shariah', String(shariah))
      if (benchmark) qs.set('benchmark', benchmark)
      const data = await fetchJson(`${API}/api/performance?${qs}`)
      ;({ funds: rows, asOf, benchmarks } = data)
    } else {
      const perf = await getPerformance()
      if (!perf) return text({ error: 'This dataset mirror has no performance.json yet.' })
      const override = benchmark ? await getIndex(benchmark) : null
      asOf = perf.asOf
      benchmarks = Object.fromEntries(Object.entries(perf.benchmarks).map(([name, b]) => [name, b.returns[period]]))
      rows = []
      for (const f of perf.funds) {
        if (f.stale) continue
        if (style !== 'all' && f.passive !== (style === 'passive')) continue
        if (category && f.category.toLowerCase() !== category.toLowerCase()) continue
        if (amc && f.amc.toLowerCase() !== amc.toLowerCase()) continue
        if (shariah !== undefined && f.shariah !== shariah) continue
        const r = f.returns[period]
        if (!r || r.anomalies > 0) continue
        const name = benchmark ?? f.benchmark
        const benchmarkPct = override ? indexReturn(override, r.fromDate, f.asOf) : r.benchmarkPct
        if (!name || benchmarkPct === null || benchmarkPct === undefined) continue
        rows.push({
          fundId: f.fundId, name: f.name, amc: f.amc, category: f.category, benchmark: name,
          ...(f.expenseRatio !== undefined ? { expenseRatio: f.expenseRatio } : {}),
          pct: r.pct, benchmarkPct, excessPct: round2(r.pct - benchmarkPct), fromDate: r.fromDate,
        })
      }
      rows.sort((a, b) => b.excessPct - a.excessPct)
    }
    const summary = summarize(rows)
    if (groupBy === 'amc') {
      const byAmc = new Map()
      for (const r of rows) byAmc.set(r.amc, [...(byAmc.get(r.amc) ?? []), r])
      let amcs = [...byAmc].map(([name, list]) => ({
        amc: name, ...summarize(list), avgExcessPct: meanOf(list.map(r => r.excessPct)),
        best: `${list[0].name} (${list[0].excessPct > 0 ? '+' : ''}${list[0].excessPct})`,
        worst: `${list.at(-1).name} (${list.at(-1).excessPct > 0 ? '+' : ''}${list.at(-1).excessPct})`,
      })).sort((a, b) => b.avgExcessPct - a.avgExcessPct)
      if (order === 'worst') amcs.reverse()
      return text({ period, asOf, benchmarks, summary, amcs: amcs.slice(0, limit), note: LEAGUE_NOTE })
    }
    const ranked = order === 'worst' ? [...rows].reverse() : rows
    const slim = ({ fundId, name, amc, category, benchmark, expenseRatio, pct, benchmarkPct, excessPct }) =>
      ({ fundId, name, amc, category, benchmark, expenseRatio, pct, benchmarkPct, excessPct })
    return text({ period, asOf, benchmarks, summary, returned: Math.min(limit, ranked.length), funds: ranked.slice(0, limit).map(slim), note: LEAGUE_NOTE })
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
      const total = await fundReturns(id).catch(() => null)
      if (computed && total?.returns) computed.returns = total.returns
      const pct = (p) => {
        if (!p) return 'n/a'
        const vs = p.benchmarkPct === null || p.benchmarkPct === undefined ? '' :
          `, ${total.benchmark} ${p.benchmarkPct > 0 ? '+' : ''}${p.benchmarkPct}%, gap ${p.excessPct > 0 ? '+' : ''}${p.excessPct} points`
        return `${p.pct > 0 ? '+' : ''}${p.pct}% (since ${p.fromDate}${vs})`
      }
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
          'Trailing total returns (payouts reinvested, net of fees, cumulative not annualized):',
          `1 month: ${pct(r['1m'])}`, `3 months: ${pct(r['3m'])}`, `Year to date: ${pct(r.ytd)}`,
          `1 year: ${pct(r['1y'])}`, `3 years: ${pct(r['3y'])}`, `Since tracking began: ${pct(r.sinceTracking)}`,
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
