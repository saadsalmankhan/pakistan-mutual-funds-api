// Hosted (remote) entry point: the same MCP server as index.js, served over
// Streamable HTTP from a Cloudflare Worker so clients that only take a URL —
// claude.ai custom connectors, ChatGPT connectors, the OpenAI/Anthropic APIs'
// MCP tool — can use it without installing anything.
//
//   POST /mcp     the MCP endpoint (also accepted on POST / for people who
//                 paste the bare origin)
//   GET  /        human-readable setup page
//   GET  /health  liveness + version
//
// Deliberately stateless: every request gets a fresh server and transport,
// answers with plain JSON (no SSE stream, no session id), and nothing is kept
// between calls except the dataset cache inside server.js. The tools are pure
// lookups, so there is no state worth a Durable Object. No auth either: the
// data is public and read-only.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer, VERSION } from './server.js'

// Cache dataset files at Cloudflare's edge for a few minutes on top of
// server.js's in-isolate cache. The dataset changes once a business day.
const FETCH_INIT = { cf: { cacheTtl: 300, cacheEverything: true } }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
}

function withCors(res) {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v)
  return out
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

async function handleMcp(request, ctx) {
  // Stateless servers have no stream to open (GET) or session to end
  // (DELETE); the spec's answer for both is 405.
  if (request.method !== 'POST') {
    return json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless, send JSON-RPC over POST.' }, id: null },
      405,
      { Allow: 'POST, OPTIONS' }
    )
  }
  const server = createServer({ chatgptTools: true, fetchInit: FETCH_INIT })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    ctx.waitUntil(server.close().catch(() => {}))
  }
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    try {
      if (url.pathname === '/mcp' || (url.pathname === '/' && request.method === 'POST')) {
        return withCors(await handleMcp(request, ctx))
      }
      if (url.pathname === '/health') {
        return withCors(json({ ok: true, name: 'pakistan-mutual-funds', version: VERSION }))
      }
      if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(landingPage(`${url.origin}/mcp`), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        })
      }
      return withCors(json({ error: 'Not found. The MCP endpoint is POST /mcp.' }, 404))
    } catch (err) {
      console.error('unhandled', err)
      return withCors(json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, 500))
    }
  },
}

function landingPage(endpoint) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pakistan Mutual Funds MCP connector</title>
<meta name="description" content="Free MCP connector for Claude and ChatGPT: daily NAVs, NAV history and returns for ~550 Pakistani mutual funds, sourced from MUFAP.">
<style>
  :root { --bg:#f7f3ec; --ink:#2b2622; --muted:#6f655c; --clay:#b5573a; --card:#fffdf9; --line:#e6ddd0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1d1a17; --ink:#efe8de; --muted:#a79c90; --clay:#e08a6b; --card:#26221e; --line:#3a342e; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .5rem; letter-spacing: -.01em; }
  h2 { font-size: 1.1rem; margin: 2.25rem 0 .5rem; }
  p, li { color: var(--ink); } .lede { color: var(--muted); font-size: 1.05rem; margin-top: 0; }
  a { color: var(--clay); }
  code, pre { font: .9rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .url { display:block; background:var(--card); border:1px solid var(--line); border-left:4px solid var(--clay); border-radius:8px; padding:.9rem 1rem; margin:1rem 0; overflow-x:auto; white-space:nowrap; }
  ol { padding-left: 1.25rem; } li { margin: .25rem 0; }
  table { border-collapse: collapse; width:100%; font-size:.95rem; } td { border-top:1px solid var(--line); padding:.5rem .5rem .5rem 0; vertical-align:top; }
  td:first-child { white-space:nowrap; } .scroll { overflow-x:auto; }
  footer { margin-top:3rem; color:var(--muted); font-size:.9rem; border-top:1px solid var(--line); padding-top:1rem; }
</style>
</head>
<body>
<main>
  <h1>Pakistan Mutual Funds, inside your AI assistant</h1>
  <p class="lede">A free MCP connector for daily NAVs, NAV history and returns on about 550 Pakistani mutual funds and VPS pension funds. The data comes from MUFAP and refreshes every business day. No account and no API key.</p>

  <code class="url">${endpoint}</code>

  <h2>Add it to Claude</h2>
  <ol>
    <li>Open <strong>Customize</strong>, then <strong>Connectors</strong>. Click <strong>+</strong> and choose <strong>Add custom connector</strong>.</li>
    <li>Name it <em>Pakistan Mutual Funds</em>, paste the URL above and click <strong>Add</strong>. Skip the advanced settings, there is no login.</li>
    <li>In a chat, click <strong>+</strong> at the lower left, open <strong>Connectors</strong> and switch it on. Then ask something like "which equity funds beat the KSE-100 over 3 years after fees?".</li>
  </ol>
  <p>This works on every plan. The free plan allows one custom connector. <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp">Claude's own guide</a> covers it in more detail.</p>
  <p>Using Claude Code instead? Run <code>claude mcp add --transport http pakistan-mutual-funds ${endpoint}</code></p>

  <h2>Add it to ChatGPT</h2>
  <ol>
    <li>On the web, open <strong>Settings</strong>, then <strong>Security and login</strong> and turn on <strong>Developer mode</strong>.</li>
    <li>Go to <strong>Plugins</strong>, click the plus button and create an app for a remote MCP server. Paste the URL above and pick <strong>No Authentication</strong>.</li>
    <li>In a new chat, choose <strong>Developer mode</strong> from the plus menu, select the app and ask away.</li>
  </ol>
  <p>Developer mode needs a Plus, Pro, Business, Enterprise or Education account. Menus move around, so if these steps look off check <a href="https://developers.openai.com/api/docs/guides/developer-mode">OpenAI's developer mode guide</a>.</p>

  <h2>What it can do</h2>
  <div class="scroll"><table>
    <tr><td><code>list_funds</code></td><td>Filter funds by name, category, AMC or Shariah status, with current NAVs</td></tr>
    <tr><td><code>get_fund</code></td><td>One fund in full: NAV, offer price, benchmark, expense ratio, management fee, inception</td></tr>
    <tr><td><code>get_performance</code></td><td>Who beat the market after fees: funds or asset managers ranked against the KSE-100 and KMI-30</td></tr>
    <tr><td><code>get_returns</code></td><td>Total returns from 1 month to 3 years with payouts reinvested, next to the fund's benchmark</td></tr>
    <tr><td><code>get_nav_history</code></td><td>Daily, weekly or monthly NAV series back to 2022</td></tr>
    <tr><td><code>get_filters</code></td><td>Every category and AMC name</td></tr>
    <tr><td><code>search</code>, <code>fetch</code></td><td>The pair ChatGPT uses for deep research</td></tr>
  </table></div>

  <h2>Good to know</h2>
  <p>Returns are total returns: NAV change with every payout reinvested, net of fund fees, cumulative and not annualized. They match MUFAP's own figures within 1 percentage point at 1 and 2 years. League tables leave out funds that closed or merged, which flatters the share that beat the index. Expense ratios are fiscal year to date and reset every July 1. This is data, not investment advice.</p>

  <footer>
    Built by <a href="https://saadsalman.org">Saad Salman</a>. Read <a href="https://saadsalman.org/blog/free-api-pakistani-mutual-fund-navs">how it works</a>, grab the <a href="https://github.com/saadsalmankhan/pakistan-mutual-funds-data">open dataset</a> or run the <a href="https://github.com/saadsalmankhan/pakistan-mutual-funds-api">API and MCP server</a> yourself. Version ${VERSION}.
  </footer>
</main>
</body>
</html>`
}
