// End-to-end health check of what users actually get: the published dataset
// files and the hosted MCP connector. It reads them over HTTP exactly as a
// consumer would, so it catches problems no job log shows, like a league
// table that silently came back empty for a month in Oct 2026.
//
//   npm run healthcheck
//
// Every check ends as ok, warn or fail. fail means users are getting wrong or
// missing answers right now; warn means redundancy is degraded or something
// is drifting and needs a look, but answers are still right. Exits 1 on any
// fail. The dataset repo's health workflow runs this every few hours and
// turns failures into a GitHub issue (which emails the owner), closing it
// again when the check passes.
//
// Env: DATASET_BASE_URL (raw file base of the dataset), CONNECTOR_URL (the
// MCP endpoint), HEALTH_REPORT_FILE (where to write the JSON report).
import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const DATASET = (process.env.DATASET_BASE_URL || 'https://raw.githubusercontent.com/saadsalmankhan/pakistan-mutual-funds-data/main').replace(/\/$/, '')
const CONNECTOR = process.env.CONNECTOR_URL || 'https://funds.saadsalman.org/mcp'
const REPORT_FILE = process.env.HEALTH_REPORT_FILE

type Level = 'ok' | 'warn' | 'fail'
interface Check { id: string; level: Level; message: string }
const checks: Check[] = []
const record = (id: string, level: Level, message: string) => { checks.push({ id, level, message }) }

const karachiNow = () => new Date(Date.now() + 5 * 3600 * 1000)
const todayKarachi = () => karachiNow().toISOString().slice(0, 10)

// Weekdays strictly after `from` up to and including `to` (YYYY-MM-DD).
// MUFAP and PSX don't publish on weekends; public holidays aren't known
// here, so a fail right after a long holiday can be a false alarm.
function weekdaysBetween(from: string, to: string): number {
  let n = 0
  const d = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  for (d.setUTCDate(d.getUTCDate() + 1); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) n++
  }
  return n
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${DATASET}/${path}`, { signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  return res.json() as Promise<T>
}

interface PerfFile {
  asOf: string
  warnings?: string[]
  benchmarks: Record<string, { asOf: string }>
  funds: Array<{ stale: boolean; returns: Record<string, { benchmarkPct: number | null } | null> }>
}

async function checkDataset() {
  // Snapshot: rewritten by every successful nightly scrape.
  try {
    const snap = await getJson<{ updatedAt: string; funds: unknown[] }>('funds.json')
    const updated = snap.updatedAt.slice(0, 10)
    const missed = weekdaysBetween(updated, todayKarachi())
    const msg = `funds.json updated ${snap.updatedAt} (${snap.funds.length} funds)`
    // The nightly run lands late evening PKT, so one missed weekday is just
    // "tonight's run hasn't happened yet".
    if (missed >= 3) record('snapshot', 'fail', `${msg}: ${missed} weekdays without a refresh`)
    else if (missed >= 2) record('snapshot', 'warn', `${msg}: ${missed} weekdays without a refresh`)
    else record('snapshot', 'ok', msg)
    if (snap.funds.length < 400) record('snapshot-size', 'fail', `funds.json lists only ${snap.funds.length} funds (normally ~560)`)
  } catch (err) {
    record('snapshot', 'fail', `funds.json unreadable: ${(err as Error).message}`)
  }

  // Performance table: NAV freshness, benchmark freshness, non-empty league.
  let perf: PerfFile | null = null
  try {
    perf = await getJson<PerfFile>('performance.json')
  } catch (err) {
    record('performance', 'fail', `performance.json unreadable: ${(err as Error).message}`)
  }
  if (perf) {
    const missed = weekdaysBetween(perf.asOf, todayKarachi())
    if (missed >= 3) record('nav-freshness', 'fail', `newest NAV is ${perf.asOf}, ${missed} weekdays old`)
    else if (missed >= 2) record('nav-freshness', 'warn', `newest NAV is ${perf.asOf}, ${missed} weekdays old`)
    else record('nav-freshness', 'ok', `newest NAV ${perf.asOf}`)

    const live = perf.funds.filter(f => !f.stale).length
    if (live < perf.funds.length * 0.8) record('nav-coverage', 'fail', `only ${live} of ${perf.funds.length} funds have a current NAV`)
    else record('nav-coverage', 'ok', `${live} of ${perf.funds.length} funds current`)

    for (const [name, b] of Object.entries(perf.benchmarks)) {
      const lag = weekdaysBetween(b.asOf, perf.asOf)
      if (lag >= 3) record(`benchmark-${name}`, 'fail', `${name} ends ${b.asOf}, ${lag} weekdays behind the fund data`)
      else if (lag >= 2) record(`benchmark-${name}`, 'warn', `${name} ends ${b.asOf}, ${lag} weekdays behind the fund data`)
      else record(`benchmark-${name}`, 'ok', `${name} to ${b.asOf}`)
    }
    for (const w of perf.warnings ?? []) record('performance-warning', 'fail', w)

    const compared = perf.funds.filter(f => !f.stale && f.returns['1y']?.benchmarkPct != null).length
    if (compared < 30) record('league-table', 'fail', `only ${compared} funds have a 1y benchmark comparison (normally ~80)`)
    else record('league-table', 'ok', `${compared} funds compared against a benchmark over 1y`)
  }

  // Index sources: redundancy status from the last refresh.
  try {
    const status = await getJson<{
      checkedAt: string
      sources: Record<string, { ok: boolean; detail: string }>
      conflicts: Array<{ index: string; date: string; values: Record<string, number>; stored?: number }>
    }>('indices/sources.json')
    const down = Object.entries(status.sources).filter(([, s]) => !s.ok)
    if (down.length === Object.keys(status.sources).length) {
      record('index-sources', 'fail', `every index source failed on the last run (${status.checkedAt})`)
    }
    for (const [name, s] of down) record(`index-source-${name}`, 'warn', `${name} down on the last run: ${s.detail}`)
    if (!down.length) record('index-sources', 'ok', `all index sources answered (${status.checkedAt})`)
    for (const c of status.conflicts) {
      const stored = c.stored !== undefined ? `, on file ${c.stored}` : ''
      record(`index-conflict-${c.index}-${c.date}`, 'warn', `${c.index} ${c.date}: sources disagree ${JSON.stringify(c.values)}${stored}`)
    }
  } catch (err) {
    record('index-sources', 'warn', `indices/sources.json unreadable: ${(err as Error).message}`)
  }
}

async function mcpCall(method: string, params: unknown) {
  const started = Date.now()
  const res = await fetch(CONNECTOR, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'pakistan-mutual-funds-healthcheck' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(45000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return { result: body.result, ms: Date.now() - started }
}

async function checkConnector() {
  try {
    const health = await fetch(CONNECTOR.replace(/\/mcp$/, '/health'), { signal: AbortSignal.timeout(20000) })
    if (!health.ok) record('connector-up', 'fail', `${CONNECTOR} /health answered HTTP ${health.status}`)
    else record('connector-up', 'ok', 'connector /health ok')
  } catch (err) {
    record('connector-up', 'fail', `connector unreachable: ${(err as Error).message}`)
    return
  }
  try {
    const { result, ms } = await mcpCall('tools/call', { name: 'get_performance', arguments: { period: '1y', category: 'Equity', limit: 3 } })
    const data = JSON.parse(result?.content?.[0]?.text ?? '{}') as { summary?: { funds: number }; warnings?: string[] }
    if (result?.isError || !data.summary) record('connector-answer', 'fail', 'get_performance returned an error')
    else if (!data.summary.funds) record('connector-answer', 'fail', `get_performance answered with 0 funds${data.warnings?.length ? `: ${data.warnings.join(' ')}` : ''}`)
    else record('connector-answer', ms > 15000 ? 'warn' : 'ok', `get_performance ranked ${data.summary.funds} equity funds in ${ms} ms`)
  } catch (err) {
    record('connector-answer', 'fail', `get_performance call failed: ${(err as Error).message}`)
  }
}

await checkDataset()
await checkConnector()

const failures = checks.filter(c => c.level === 'fail')
const warnings = checks.filter(c => c.level === 'warn')
// Identifies the set of failing checks, so the alert workflow comments only
// when what's broken changes, not every few hours while it stays broken.
const fingerprint = createHash('sha1').update(failures.map(c => c.id).sort().join('|')).digest('hex').slice(0, 12)
const icon = { ok: '✅', warn: '⚠️', fail: '❌' }
const markdown = [
  `Checked ${new Date().toISOString()} against ${DATASET} and ${CONNECTOR}.`,
  '',
  '| | Check | Detail |',
  '|---|---|---|',
  ...checks.map(c => `| ${icon[c.level]} | ${c.id} | ${c.message.replace(/\|/g, '\\|')} |`),
].join('\n')

const report = { ok: failures.length === 0, fingerprint, failures, warnings, checks, markdown }
if (REPORT_FILE) await writeFile(REPORT_FILE, JSON.stringify(report, null, 1), 'utf-8')
for (const c of checks) console.log(`${c.level.toUpperCase().padEnd(4)} ${c.id}: ${c.message}`)
console.log(`\n${failures.length} failing, ${warnings.length} warning`)
process.exit(failures.length ? 1 : 0)
