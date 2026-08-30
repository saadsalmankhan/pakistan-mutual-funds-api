// Smoke test: connect a real MCP client to the server over stdio and
// exercise every tool against the live public dataset.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({ command: 'node', args: ['./index.js'] })
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

const filters = parse(await client.callTool({ name: 'get_filters', arguments: {} }))
console.log('get_filters:', filters.categories.length, 'categories,', filters.amcs.length, 'AMCs')

const shariah = parse(await client.callTool({ name: 'list_funds', arguments: { shariah: true, category: 'Shariah Compliant Equity', limit: 2 } }))
console.log('list_funds(shariah equity):', shariah.totalMatches, 'matches')

await client.close()
console.log('ALL TOOL CALLS OK')
