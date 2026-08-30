// OpenAPI 3.1 description of the API, served at GET /openapi.json.
// Kept as a typed constant so it ships in the build with zero file plumbing.

const fund = {
  type: 'object',
  properties: {
    fundId: { type: 'string', description: "MUFAP's internal fund id" },
    name: { type: 'string' },
    amc: { type: 'string', description: 'Asset Management Company' },
    nav: { type: 'number', description: 'Net asset value per unit (PKR)' },
    offerPrice: { type: 'number' },
    category: { type: 'string' },
    shariah: { type: 'boolean' },
    benchmark: { type: ['string', 'null'], description: 'KSE-100, KMI-30 or null' },
    inceptionDate: { type: 'string' },
    expenseRatio: { type: 'number', description: 'TER YTD %' },
    managementFee: { type: 'number', description: 'MF %' },
  },
  required: ['fundId', 'name', 'amc', 'nav', 'offerPrice', 'category', 'shariah', 'benchmark'],
} as const

const historyEntry = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD, Asia/Karachi scrape date' },
    nav: { type: 'number' },
    offerPrice: { type: 'number' },
  },
  required: ['date', 'nav', 'offerPrice'],
} as const

const periodReturn = {
  type: ['object', 'null'],
  description: 'null until tracked history reaches back far enough',
  properties: {
    pct: { type: 'number', description: 'Simple NAV % change, not annualized' },
    fromDate: { type: 'string' },
    fromNav: { type: 'number' },
  },
} as const

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: "MUFAP fund id (the fundId field)",
} as const

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Pakistan Mutual Funds API',
    version: '1.2.0',
    description:
      'Self-hosted REST API for Pakistani mutual fund NAVs, scraped daily from ' +
      "MUFAP's public Fund Directory. Free public dataset of the same data: " +
      'https://github.com/saadsalmankhan/pakistan-mutual-funds-data',
    license: { name: 'MIT' },
    contact: { name: 'Saad Salman', url: 'https://saadsalman.org' },
  },
  servers: [{ url: 'http://localhost:4000', description: 'Default local instance' }],
  paths: {
    '/api/funds': {
      get: {
        summary: 'List funds with optional filters',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Exact category, case-insensitive' },
          { name: 'amc', in: 'query', schema: { type: 'string' }, description: 'Exact AMC name, case-insensitive' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Fund name substring' },
          { name: 'shariah', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
        ],
        responses: {
          '200': {
            description: 'Funds and snapshot timestamp',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    funds: { type: 'array', items: fund },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '304': { description: 'Not modified (If-Modified-Since)' },
        },
      },
    },
    '/api/funds/{id}': {
      get: {
        summary: 'One fund by id',
        parameters: [idParam],
        responses: {
          '200': { description: 'The fund', content: { 'application/json': { schema: fund } } },
          '404': { description: 'Unknown fund id' },
        },
      },
    },
    '/api/funds/{id}/history': {
      get: {
        summary: 'Accumulated NAV history (oldest first)',
        parameters: [
          idParam,
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Inclusive lower bound' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Inclusive upper bound' },
        ],
        responses: {
          '200': {
            description: 'History entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fundId: { type: 'string' },
                    history: { type: 'array', items: historyEntry },
                  },
                },
              },
            },
          },
          '404': { description: 'No history for this fund id' },
        },
      },
    },
    '/api/funds/{id}/returns': {
      get: {
        summary: 'Trailing returns computed from history',
        parameters: [idParam],
        responses: {
          '200': {
            description:
              'Simple NAV percentage change per period. Not annualized; payouts not accounted for.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fundId: { type: 'string' },
                    latestDate: { type: 'string' },
                    latestNav: { type: 'number' },
                    returns: {
                      type: 'object',
                      properties: {
                        '1m': periodReturn,
                        '3m': periodReturn,
                        ytd: periodReturn,
                        '1y': periodReturn,
                        sinceTracking: periodReturn,
                      },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'No history for this fund id' },
        },
      },
    },
    '/api/categories': {
      get: {
        summary: 'Distinct fund categories',
        responses: { '200': { description: 'Sorted category names' } },
      },
    },
    '/api/amcs': {
      get: {
        summary: 'Distinct AMC names',
        responses: { '200': { description: 'Sorted AMC names' } },
      },
    },
    '/health': {
      get: { summary: 'Liveness check', responses: { '200': { description: '{"ok":true}' } } },
    },
  },
} as const
