#!/usr/bin/env node
// MCP server for Pakistani mutual fund data (NAVs, history, returns).
//
// Zero-setup by default: reads the free public dataset that a GitHub Action
// updates every business day (github.com/saadsalmankhan/pakistan-mutual-funds-data).
// Point API_BASE_URL at a self-hosted pakistan-mutual-funds-api instance to
// use live endpoints instead.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const RAW = 'https://raw.githubusercontent.com/saadsalmankhan/pakistan-mutual-funds-data/main'
const API = process.env.API_BASE_URL?.replace(/\/$/, '')
const CACHE_MS = 15 * 60 * 1000

let fundsCache = null
let fundsCacheAt = 0

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json()
}

async function getFunds() {
  if (fundsCache && Date.now() - fundsCacheAt < CACHE_MS) return fundsCache
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
  return data
}

async function getHistory(fundId) {
  if (API) {
    const data = await fetchJson(`${API}/api/funds/${encodeURIComponent(fundId)}/history`)
    return data.history
  }
  const safe = fundId.replace(/[^\w.-]/g, '_').slice(0, 120)
  const res = await fetch(`${RAW}/history/${safe}.ndjson`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching history for ${fundId}`)
  const text = await res.text()
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

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

const server = new McpServer({ name: 'pakistan-mutual-funds', version: '0.1.0' })

server.registerTool('list_funds', {
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
  description: 'Full record for one fund by its MUFAP fundId: NAV, offer price, category, Shariah status, benchmark, expense ratio, management fee, inception date.',
  inputSchema: { fundId: z.string().describe('MUFAP fund id, e.g. "12768" (from list_funds)') },
}, async ({ fundId }) => {
  const { funds, updatedAt } = await getFunds()
  const fund = funds.find(f => f.fundId === fundId)
  if (!fund) return text({ error: `Unknown fundId ${fundId}. Use list_funds to find ids.` })
  return text({ ...fund, updatedAt })
})

server.registerTool('get_nav_history', {
  description:
    'Daily NAV time series for one fund, oldest first. Use interval weekly/monthly for long ranges to keep output compact. ' +
    'Dates are Asia/Karachi business days.',
  inputSchema: {
    fundId: z.string().describe('MUFAP fund id'),
    from: z.string().optional().describe('Inclusive lower bound, YYYY-MM-DD'),
    to: z.string().optional().describe('Inclusive upper bound, YYYY-MM-DD'),
    interval: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Thin the series: last entry per week/month. Default daily.'),
  },
}, async ({ fundId, from, to, interval }) => {
  let history = await getHistory(fundId)
  if (history === null) return text({ error: `No history for fundId ${fundId}` })
  if (from) history = history.filter(e => e.date >= from)
  if (to) history = history.filter(e => e.date <= to)
  const thinned = thin(history, interval ?? 'daily')
  return text({ fundId, interval: interval ?? 'daily', points: thinned.length, history: thinned })
})

server.registerTool('get_returns', {
  description:
    'Trailing returns for one fund: 1m, 3m, YTD, 1y and sinceTracking. Simple NAV percentage change, not annualized, ' +
    'payouts not included. A period is null when history does not reach back that far.',
  inputSchema: { fundId: z.string().describe('MUFAP fund id') },
}, async ({ fundId }) => {
  const history = await getHistory(fundId)
  if (history === null) return text({ error: `No history for fundId ${fundId}` })
  const result = computeReturns(history)
  if (!result) return text({ error: `No history entries for fundId ${fundId}` })
  return text({ fundId, ...result })
})

server.registerTool('get_filters', {
  description: 'All distinct fund categories and AMC names, for building precise list_funds queries.',
  inputSchema: {},
}, async () => {
  const { funds } = await getFunds()
  return text({
    categories: [...new Set(funds.map(f => f.category))].sort(),
    amcs: [...new Set(funds.map(f => f.amc))].sort(),
  })
})

const transport = new StdioServerTransport()
await server.connect(transport)
