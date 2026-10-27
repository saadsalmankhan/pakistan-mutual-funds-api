// Usage analytics and request logging for the hosted connector (worker.js).
//
// Every MCP request is logged as one JSON line (Cloudflare Workers Logs,
// enabled in wrangler.jsonc) and recorded as one row per JSON-RPC message in
// a D1 database bound as USAGE_DB. Recording happens in ctx.waitUntil, after
// the response has gone out, so it never slows a user down, and any failure
// to record is swallowed: analytics must never break the connector.
//
// What a row can and can't say. The connector is stateless and has no login,
// and claude.ai and ChatGPT call it from their own servers, so individual
// people can't be counted. What can be: connections (MCP `initialize`
// handshakes, which carry the client app's name, e.g. claude-ai, openai-mcp,
// Cursor), tool calls, errors, latency, the caller's country, and a rough
// count of distinct callers via `client_key` — a salted hash of IP and
// user-agent. Raw IPs are never stored, and without the secret salt the key
// can't be turned back into one.
//
// No USAGE_DB binding (local dev, a fork) means no recording; requests are
// still logged.

// Table definition: schema.sql (applied with `npm run db:migrate`).

// Our own traffic: the health monitor and the smoke tests. Recorded (useful
// for latency) but left out of usage numbers.
const INTERNAL_UA = /healthcheck/i
const INTERNAL_CLIENTS = new Set(['smoke-test', 'remote-smoke-test', 'health-check'])

// Version negotiation, not failures. claude.ai first tries server/discover
// with a protocol version newer than the SDK speaks; the 400 it gets back
// makes it fall back to initialize, which then succeeds. Recorded as
// 'unsupported' so these probes don't show up as errors.
const NEGOTIATION_METHODS = new Set(['server/discover'])
const NOT_ERRORS = "status NOT IN ('ok', 'unsupported')"

// The JSON-RPC messages in a request body (a single message or a batch).
export async function readMessages(request) {
  try {
    const body = await request.clone().json()
    return (Array.isArray(body) ? body : [body]).filter(m => m && typeof m.method === 'string')
  } catch {
    return []
  }
}

// Outcome per JSON-RPC id from the JSON response: ok, tool_error (the tool
// ran but reported isError) or rpc_error.
async function readOutcomes(response) {
  const outcomes = new Map()
  try {
    const body = await response.clone().json()
    for (const msg of Array.isArray(body) ? body : [body]) {
      if (msg?.id === undefined) continue
      outcomes.set(msg.id, msg.error ? 'rpc_error' : msg.result?.isError ? 'tool_error' : 'ok')
    }
  } catch {
    // not JSON (a 202 for notifications, a 405...): nothing to read
  }
  return outcomes
}

// Without the secret salt the hash could be brute-forced back to an IPv4
// address, so no salt means no key at all rather than a weak one.
async function clientKey(request, salt) {
  if (!salt) return null
  const ip = request.headers.get('cf-connecting-ip') ?? ''
  const ua = request.headers.get('user-agent') ?? ''
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}|${ua}`))
  return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Log the request and, when a database is bound, record it.
export async function recordRequest({ env, request, response, messages, startedAt, error }) {
  const ms = Date.now() - startedAt
  const ua = (request.headers.get('user-agent') ?? '').slice(0, 120)
  const country = request.cf?.country ?? null
  const outcomes = response ? await readOutcomes(response) : new Map()
  const rows = (messages.length ? messages : [{ method: '(unparsed)' }]).map(m => {
    const clientInfo = m.method === 'initialize' ? m.params?.clientInfo : undefined
    let status = error ? 'exception'
      : response && response.status >= 400 ? 'http_error'
      : outcomes.get(m.id) ?? 'ok'
    if (NEGOTIATION_METHODS.has(m.method) && (status === 'http_error' || status === 'rpc_error')) status = 'unsupported'
    return {
      method: m.method,
      tool: m.method === 'tools/call' ? String(m.params?.name ?? '') : null,
      client: clientInfo?.name ? String(clientInfo.name).slice(0, 60) : null,
      client_version: clientInfo?.version ? String(clientInfo.version).slice(0, 30) : null,
      status,
      internal: INTERNAL_UA.test(ua) || INTERNAL_CLIENTS.has(clientInfo?.name) ? 1 : 0,
    }
  })

  for (const r of rows) {
    const line = { event: 'mcp', ...r, ms, country, ua, http: response?.status ?? null }
    if (error) console.error(JSON.stringify({ ...line, error: String(error?.stack ?? error) }))
    else console.log(JSON.stringify(line))
  }

  if (!env?.USAGE_DB) return
  try {
    const key = await clientKey(request, env.HASH_SALT)
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    const insert = env.USAGE_DB.prepare(
      'INSERT INTO events (ts, day, method, tool, client, client_version, ua, client_key, country, status, ms, internal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    await env.USAGE_DB.batch(rows.map(r =>
      insert.bind(now, day, r.method, r.tool, r.client, r.client_version, ua, key, country, r.status, ms, r.internal)
    ))
  } catch (err) {
    console.error(JSON.stringify({ event: 'usage-record-failed', error: String(err) }))
  }
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null)

// Aggregates for GET /stats. Excludes our own monitoring traffic.
export async function usageStats(db, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const q = (sql, ...args) => db.prepare(sql).bind(since, ...args).all().then(r => r.results)
  const base = 'FROM events WHERE day >= ? AND internal = 0'

  const [totals] = await q(`SELECT
      COUNT(*) AS requests,
      SUM(method = 'initialize') AS connections,
      SUM(method = 'tools/call') AS toolCalls,
      SUM(${NOT_ERRORS}) AS errors,
      COUNT(DISTINCT client_key) AS distinctCallers
    ${base}`)
  const byDay = await q(`SELECT day,
      COUNT(*) AS requests,
      SUM(method = 'initialize') AS connections,
      SUM(method = 'tools/call') AS toolCalls,
      SUM(${NOT_ERRORS}) AS errors,
      COUNT(DISTINCT client_key) AS distinctCallers
    ${base} GROUP BY day ORDER BY day`)
  const byTool = await q(`SELECT tool, COUNT(*) AS calls, SUM(${NOT_ERRORS}) AS errors
    ${base} AND method = 'tools/call' GROUP BY tool ORDER BY calls DESC`)
  const byClient = await q(`SELECT COALESCE(client, '(unknown)') AS client, COUNT(*) AS connections, COUNT(DISTINCT client_key) AS distinctCallers
    ${base} AND method = 'initialize' GROUP BY client ORDER BY connections DESC LIMIT 20`)
  const byCountry = await q(`SELECT COALESCE(country, '??') AS country, COUNT(*) AS requests
    ${base} GROUP BY country ORDER BY requests DESC LIMIT 15`)
  const byUserAgent = await q(`SELECT ua, COUNT(*) AS requests
    ${base} GROUP BY ua ORDER BY requests DESC LIMIT 10`)
  const errors = await q(`SELECT day, method, tool, status, COUNT(*) AS n
    ${base} AND ${NOT_ERRORS} GROUP BY day, method, tool, status ORDER BY day DESC LIMIT 20`)
  const latencies = (await q(`SELECT ms ${base} AND method = 'tools/call' AND ms IS NOT NULL ORDER BY ms LIMIT 20000`)).map(r => r.ms)

  return {
    since,
    days,
    note: 'Our own monitoring traffic excluded. A connection is one MCP initialize handshake; distinctCallers counts distinct (IP, user-agent) pairs, so everyone using claude.ai or ChatGPT can look like a handful of callers.',
    totals,
    toolLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    byDay,
    byTool,
    byClient,
    byCountry,
    byUserAgent,
    errors,
  }
}
