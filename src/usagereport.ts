// Weekly usage report for the hosted connector and the packages around it,
// as markdown. The dataset repo's weekly workflow posts it as a GitHub issue
// (which emails the owner).
//
//   STATS_KEY=... npm run usage-report
//
// Sources: the connector's own /stats endpoint (usage.js, key-protected),
// npm's public download counts for the local MCP package, and GitHub's
// public repo counters. Each section is independent: one source failing just
// says so in its section.
//
// Env: STATS_URL (default https://funds.saadsalman.org/stats), STATS_KEY,
// GITHUB_TOKEN (optional, raises GitHub's rate limit), REPORT_FILE (where to
// write the markdown; stdout otherwise).
import 'dotenv/config'
import { writeFile } from 'node:fs/promises'

const STATS_URL = process.env.STATS_URL || 'https://funds.saadsalman.org/stats'
const STATS_KEY = process.env.STATS_KEY
const NPM_PACKAGE = 'pakistan-mutual-funds-mcp'
const REPOS = ['saadsalmankhan/pakistan-mutual-funds-api', 'saadsalmankhan/pakistan-mutual-funds-data']

type Row = Record<string, number | string | null>
interface Stats {
  since: string
  totals: Row
  toolLatencyMs: { p50: number | null; p95: number | null }
  byDay: Array<{ day: string; requests: number; connections: number; toolCalls: number; errors: number; distinctCallers: number }>
  byTool: Row[]
  byClient: Row[]
  byCountry: Row[]
  errors: Row[]
}

const lines: string[] = []
const out = (s = '') => lines.push(s)
const n = (v: unknown) => Number(v ?? 0)
const change = (now: number, before: number) => {
  if (!before) return now ? ' (new)' : ''
  const pct = Math.round(((now - before) / before) * 100)
  return ` (${pct >= 0 ? '+' : ''}${pct}% vs previous week)`
}

async function connectorSection() {
  out('## Hosted connector (funds.saadsalman.org)')
  if (!STATS_KEY) { out('_No STATS_KEY configured, so connector usage is unavailable._'); return }
  let stats: Stats
  try {
    const res = await fetch(`${STATS_URL}?days=14`, { headers: { authorization: `Bearer ${STATS_KEY}` }, signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    stats = (await res.json()) as Stats
  } catch (err) {
    out(`_Couldn't read usage stats: ${(err as Error).message}_`)
    return
  }
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const thisWeek = stats.byDay.filter(d => d.day > cutoff)
  const lastWeek = stats.byDay.filter(d => d.day <= cutoff)
  const sum = (days: Stats['byDay'], k: keyof Stats['byDay'][number]) => days.reduce((a, d) => a + n(d[k]), 0)

  out(`| Last 7 days | |`)
  out('|---|---|')
  out(`| Connections (MCP handshakes) | ${sum(thisWeek, 'connections')}${change(sum(thisWeek, 'connections'), sum(lastWeek, 'connections'))} |`)
  out(`| Tool calls | ${sum(thisWeek, 'toolCalls')}${change(sum(thisWeek, 'toolCalls'), sum(lastWeek, 'toolCalls'))} |`)
  out(`| Busiest day's distinct callers | ${Math.max(0, ...thisWeek.map(d => n(d.distinctCallers)))} |`)
  out(`| Errors | ${sum(thisWeek, 'errors')} |`)
  out(`| Tool latency p50 / p95 (14 days) | ${stats.toolLatencyMs.p50 ?? '-'} ms / ${stats.toolLatencyMs.p95 ?? '-'} ms |`)
  out()
  if (thisWeek.length) {
    out('| Day | Connections | Tool calls | Distinct callers | Errors |')
    out('|---|---|---|---|---|')
    for (const d of thisWeek) out(`| ${d.day} | ${d.connections} | ${d.toolCalls} | ${d.distinctCallers} | ${d.errors} |`)
    out()
  }
  if (stats.byClient.length) out(`**Apps connecting (14 days):** ${stats.byClient.map(c => `${c.client} ${c.connections}`).join(', ')}`)
  if (stats.byTool.length) out(`**Tools used (14 days):** ${stats.byTool.map(t => `${t.tool} ${t.calls}${n(t.errors) ? ` (${t.errors} errors)` : ''}`).join(', ')}`)
  if (stats.byCountry.length) out(`**Countries (14 days):** ${stats.byCountry.slice(0, 8).map(c => `${c.country} ${c.requests}`).join(', ')}`)
  if (stats.errors.length) {
    out()
    out('**Errors (14 days):**')
    for (const e of stats.errors) out(`- ${e.day} ${e.method}${e.tool ? ` ${e.tool}` : ''}: ${e.status} x${e.n}`)
  }
  out()
  out('_A connection is one MCP handshake. claude.ai and ChatGPT call from their own servers, so distinct callers undercounts the people behind them._')
}

async function npmSection() {
  out()
  out('## Local MCP package (npm)')
  try {
    const get = async (range: string) => {
      const res = await fetch(`https://api.npmjs.org/downloads/point/${range}/${NPM_PACKAGE}`, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return n(((await res.json()) as { downloads?: number }).downloads)
    }
    const day = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)
    const week = await get(`${day(7)}:${day(1)}`)
    const before = await get(`${day(14)}:${day(8)}`)
    const month = await get(`${day(30)}:${day(1)}`)
    out(`${NPM_PACKAGE}: ${week} downloads in the last 7 days${change(week, before)}, ${month} in the last 30.`)
  } catch (err) {
    out(`_Couldn't read npm downloads: ${(err as Error).message}_`)
  }
}

async function githubSection() {
  out()
  out('## GitHub')
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  for (const repo of REPOS) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const r = (await res.json()) as { stargazers_count: number; forks_count: number; open_issues_count: number }
      out(`- ${repo}: ${r.stargazers_count} stars, ${r.forks_count} forks`)
    } catch (err) {
      out(`- ${repo}: _unavailable (${(err as Error).message})_`)
    }
  }
}

out(`# Weekly usage report, week to ${new Date().toISOString().slice(0, 10)}`)
out()
await connectorSection()
await npmSection()
await githubSection()

const markdown = lines.join('\n') + '\n'
if (process.env.REPORT_FILE) await writeFile(process.env.REPORT_FILE, markdown, 'utf-8')
else process.stdout.write(markdown)
