// Smoke test for the hosted connector: connect a real MCP client over
// Streamable HTTP and exercise every tool against the live public dataset.
//   node test-remote.mjs                        # local `npm run dev`
//   node test-remote.mjs https://host/mcp       # a deployed Worker
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const endpoint = process.argv[2] ?? 'http://localhost:8787/mcp'
const client = new Client({ name: 'remote-smoke-test', version: '0.0.1' })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
console.log('connected to', endpoint, '|', JSON.stringify(client.getServerVersion()))

const { tools } = await client.listTools()
console.log('tools:', tools.map(t => t.name).join(', '))
const notReadOnly = tools.filter(t => !t.annotations?.readOnlyHint).map(t => t.name)
if (notReadOnly.length) throw new Error(`tools missing readOnlyHint: ${notReadOnly}`)

const parse = (r) => JSON.parse(r.content[0].text)

const list = parse(await client.callTool({ name: 'list_funds', arguments: { q: 'abl cash', limit: 3 } }))
console.log('list_funds(q="abl cash"):', list.totalMatches, 'matches, first:', list.funds[0]?.name, list.funds[0]?.fundId)

const fund = parse(await client.callTool({ name: 'get_fund', arguments: { fundId: '12768' } }))
console.log('get_fund(12768):', fund.name, '| nav', fund.nav, '| TER', fund.expenseRatio)

const hist = parse(await client.callTool({ name: 'get_nav_history', arguments: { fundId: '12768', interval: 'monthly' } }))
console.log('get_nav_history(12768, monthly):', hist.points, 'points, first', hist.history[0]?.date, 'last', hist.history.at(-1)?.date)

const ret = parse(await client.callTool({ name: 'get_returns', arguments: { fundId: '12768' } }))
console.log('get_returns(12768):', JSON.stringify(Object.fromEntries(Object.entries(ret.returns).map(([k, v]) => [k, v?.pct ?? null]))))

const filters = parse(await client.callTool({ name: 'get_filters', arguments: {} }))
console.log('get_filters:', filters.categories.length, 'categories,', filters.amcs.length, 'AMCs')

// ChatGPT's contract: search -> {results:[{id,title,url}]}, fetch -> {id,title,text,url,metadata}
const search = parse(await client.callTool({ name: 'search', arguments: { query: 'meezan islamic income' } }))
if (!Array.isArray(search.results) || !search.results.every(r => r.id && r.title && r.url)) throw new Error('search result shape is off')
console.log('search("meezan islamic income"):', search.results.length, 'results, first:', search.results[0]?.title)

const doc = parse(await client.callTool({ name: 'fetch', arguments: { id: search.results[0].id } }))
for (const k of ['id', 'title', 'text', 'url', 'metadata']) if (!(k in doc)) throw new Error(`fetch result missing ${k}`)
console.log('fetch(' + doc.id + '):', doc.title, '|', doc.text.split('\n').length, 'lines |', doc.url)

const bad = await client.callTool({ name: 'fetch', arguments: { id: 'nope' } })
if (!bad.isError) throw new Error('fetch of an unknown id should be an error result')

await client.close()
console.log('ALL REMOTE TOOL CALLS OK')
