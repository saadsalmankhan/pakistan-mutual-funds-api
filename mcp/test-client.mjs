// Smoke test: connect a real MCP client to the server over stdio and
// exercise every tool against the live public dataset.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The SDK gives the child a minimal environment, so pass these through for
// testing against a self-hosted API or a local dataset checkout.
const passthrough = Object.fromEntries(['API_BASE_URL', 'DATASET_BASE_URL'].flatMap(k => (process.env[k] ? [[k, process.env[k]]] : [])))
const transport = new StdioClientTransport({ command: 'node', args: ['./index.js'], env: { PATH: process.env.PATH, ...passthrough } })
const client = new Client({ name: 'smoke-test', version: '0.0.1' })
await client.connect(transport)

const tools = await client.listTools()
console.log('tools:', tools.tools.map(t => t.name).join(', '))

const parse = (r) => JSON.parse(r.content[0].text)

const list = parse(await client.callTool({ name: 'list_funds', arguments: { q: 'abl cash', limit: 3 } }))
console.log('list_funds(q="abl cash"):', list.totalMatches, 'matches, first:', list.funds[0]?.name, list.funds[0]?.fundId)

const fund = parse(await client.callTool({ name: 'get_fund', arguments: { fundId: '12768' } }))
console.log('get_fund(12768):', fund.name, '| nav', fund.nav, '| TER', fund.expenseRatio)

const hist = parse(await client.callTool({ name: 'get_nav_history', arguments: { fundId: '12768', interval: 'weekly' } }))
console.log('get_nav_history(12768, weekly):', hist.points, 'points, first', hist.history[0]?.date, 'last', hist.history.at(-1)?.date)

const ret = parse(await client.callTool({ name: 'get_returns', arguments: { fundId: '12768' } }))
console.log('get_returns(12768):', JSON.stringify(Object.fromEntries(Object.entries(ret.returns).map(([k, v]) => [k, v?.pct ?? null]))))

const threeY = ret.returns['3y']
if (threeY && !('navPct' in threeY && 'benchmarkPct' in threeY)) throw new Error('get_returns is missing total-return fields')

const perf = parse(await client.callTool({ name: 'get_performance', arguments: { period: '3y', category: 'Equity', limit: 3 } }))
if (!perf.summary?.funds || !perf.funds?.length) throw new Error('get_performance returned no league table')
console.log(`get_performance(3y, Equity): ${perf.summary.beatBenchmark} of ${perf.summary.funds} beat KSE-100 (${perf.benchmarks['KSE-100']}%), best: ${perf.funds[0].name} ${perf.funds[0].excessPct > 0 ? '+' : ''}${perf.funds[0].excessPct}pp`)

const amcs = parse(await client.callTool({ name: 'get_performance', arguments: { period: '3y', groupBy: 'amc', limit: 2 } }))
console.log('get_performance(3y, by AMC):', amcs.amcs.map(a => `${a.amc} ${a.avgExcessPct}pp`).join(' | '))

const filters = parse(await client.callTool({ name: 'get_filters', arguments: {} }))
console.log('get_filters:', filters.categories.length, 'categories,', filters.amcs.length, 'AMCs')

const shariah = parse(await client.callTool({ name: 'list_funds', arguments: { shariah: true, category: 'Shariah Compliant Equity', limit: 2 } }))
console.log('list_funds(shariah equity):', shariah.totalMatches, 'matches')

await client.close()
console.log('ALL TOOL CALLS OK')
