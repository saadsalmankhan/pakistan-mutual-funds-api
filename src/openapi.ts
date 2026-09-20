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
    date: { type: 'string', description: "YYYY-MM-DD — MUFAP's published NAV validity date for backfilled/merged rows; Asia/Karachi scrape date for live same-day appends" },
    nav: { type: 'number' },
    offerPrice: { type: 'number' },
  },
  required: ['date', 'nav', 'offerPrice'],
} as const

const periodReturn = {
  type: ['object', 'null'],
  description: 'null until tracked history reaches back far enough',
  properties: {
    pct: { type: 'number', description: 'Total return %: NAV change with payouts reinvested at the ex-NAV. Net of fees, cumulative, not annualized' },
    navPct: { type: 'number', description: 'NAV-only % change. Understates any fund that paid out in the window' },
    fromDate: { type: 'string' },
    fromNav: { type: 'number' },
    payouts: { type: 'integer', description: 'Payouts reinvested in the window' },
    anomalies: { type: 'integer', description: 'Unexplained one-day NAV level shifts in the window (unit consolidations, source-data errors). Above 0 the return is unverified' },
    benchmarkPct: { type: ['number', 'null'], description: "The fund's benchmark index over the same dates; null without a benchmark" },
    excessPct: { type: ['number', 'null'], description: 'pct minus benchmarkPct, in percentage points' },
  },
} as const

const PERIOD_NAMES = ['1m', '3m', '6m', 'ytd', 'fytd', '1y', '2y', '3y', 'sinceTracking'] as const

const leagueParams = [
  { name: 'period', in: 'query', schema: { type: 'string', enum: PERIOD_NAMES, default: '1y' }, description: 'fytd is the Pakistani fiscal year to date (from June 30)' },
  { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Exact category, case-insensitive' },
  { name: 'amc', in: 'query', schema: { type: 'string' }, description: 'Exact AMC name, case-insensitive' },
  { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring of the fund name' },
  { name: 'shariah', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
  { name: 'style', in: 'query', schema: { type: 'string', enum: ['active', 'passive', 'all'], default: 'active' }, description: 'passive = index trackers and ETFs, whose gap to the index is tracking difference rather than skill' },
  { name: 'benchmark', in: 'query', schema: { type: 'string', enum: ['KSE-100', 'KMI-30'] }, description: "Hold every selected fund against this index instead of its own benchmark. Without it only funds that have a benchmark (equity-type categories) are listed" },
  { name: 'includeStale', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include funds that stopped reporting NAVs' },
  { name: 'includeFlagged', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include funds with anomalies in the window' },
] as const

const leagueSummary = {
  type: 'object',
  properties: {
    funds: { type: 'integer' },
    beatBenchmark: { type: 'integer' },
    beatBenchmarkPct: { type: ['number', 'null'] },
    medianPct: { type: ['number', 'null'] },
    medianExcessPct: { type: ['number', 'null'] },
    avgExpenseRatio: { type: ['number', 'null'], description: 'Mean TER (fiscal year to date) of the listed funds' },
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
    version: '1.3.0',
    description:
      'Self-hosted REST API for Pakistani mutual fund NAVs, payouts, total returns and ' +
      "benchmark comparisons, scraped daily from MUFAP's public pages and the PSX Data " +
      'Portal. Free public dataset of the same data: ' +
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
    '/api/funds/{id}/payouts': {
      get: {
        summary: 'Dividend/payout history for one fund',
        parameters: [
          idParam,
          { name: 'from', in: 'query', schema: { type: 'string' }, description: 'Inclusive lower bound, YYYY-MM-DD' },
          { name: 'to', in: 'query', schema: { type: 'string' }, description: 'Inclusive upper bound, YYYY-MM-DD' },
        ],
        responses: {
          '200': {
            description: 'Payouts oldest first (empty for a fund that never paid out). exNav is the NAV right after the payout.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fundId: { type: 'string' },
                    payouts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { date: { type: 'string' }, payout: { type: 'number', description: 'PKR per unit' }, exNav: { type: 'number' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/funds/{id}/returns': {
      get: {
        summary: 'Trailing total returns, with the benchmark comparison',
        parameters: [idParam],
        responses: {
          '200': {
            description:
              'Payout-reinvested total return per period next to the benchmark index over the same dates. Cumulative, not annualized.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fundId: { type: 'string' },
                    latestDate: { type: 'string' },
                    latestNav: { type: 'number' },
                    benchmark: { type: ['string', 'null'] },
                    returns: {
                      type: 'object',
                      properties: Object.fromEntries(PERIOD_NAMES.map(p => [p, periodReturn])),
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
    '/api/performance': {
      get: {
        summary: 'Who beat the market after fees: funds ranked by return in excess of their benchmark',
        parameters: [
          ...leagueParams,
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['excess', 'return'], default: 'excess' } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['desc', 'asc'], default: 'desc' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description:
              'Fund returns are net of fees, so excessPct is what the manager added or lost after charging for it. ' +
              'Closed and merged funds are absent (survivorship bias flatters the industry).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    period: { type: 'string' },
                    asOf: { type: 'string' },
                    benchmarks: { type: 'object', description: 'Index return over the period, by index name' },
                    summary: leagueSummary,
                    funds: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          fundId: { type: 'string' }, name: { type: 'string' }, amc: { type: 'string' },
                          category: { type: 'string' }, shariah: { type: 'boolean' }, benchmark: { type: 'string' },
                          passive: { type: 'boolean' }, expenseRatio: { type: 'number' },
                          pct: { type: 'number' }, navPct: { type: 'number' }, benchmarkPct: { type: 'number' },
                          excessPct: { type: 'number' }, beatBenchmark: { type: 'boolean' },
                          anomalies: { type: 'integer' }, fromDate: { type: 'string' }, asOf: { type: 'string' },
                        },
                      },
                    },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'Unknown period, benchmark or style' },
        },
      },
    },
    '/api/performance/amcs': {
      get: {
        summary: 'The same league table rolled up per asset manager',
        parameters: [...leagueParams],
        responses: {
          '200': { description: 'Per AMC: funds counted, how many beat their benchmark, average excess return and TER, best and worst fund' },
          '400': { description: 'Unknown period, benchmark or style' },
        },
      },
    },
    '/api/benchmarks': {
      get: {
        summary: 'Benchmark indices with their own trailing returns',
        responses: { '200': { description: 'KSE-100 and KMI-30 (both total-return indices): latest close and return per period' } },
      },
    },
    '/api/benchmarks/{name}/history': {
      get: {
        summary: 'End-of-day closes for one index',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string', enum: ['KSE-100', 'KMI-30'] }, description: 'Punctuation and case are ignored (kse100 works)' },
          { name: 'from', in: 'query', schema: { type: 'string' } },
          { name: 'to', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{benchmark, history: [{date, close}]}' }, '404': { description: 'Unknown benchmark or no history yet' } },
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
