export interface Fund {
  fundId: string
  name: string
  amc: string
  nav: number
  offerPrice: number
  category: string
  shariah: boolean
  benchmark: string | null
  // Present once `npm run enrich` has populated the metadata file:
  inceptionDate?: string
  expenseRatio?: number // TER YTD %
  managementFee?: number // MF %
}

export interface FundStore {
  funds: Fund[]
  updatedAt: string
}

export interface HistoryEntry {
  // YYYY-MM-DD, Asia/Karachi. MUFAP's NAV validity date for rows merged by
  // the backfill; the scrape date for rows appended by a live scrape.
  date: string
  nav: number
  offerPrice: number
}

// One dividend/payout, from MUFAP's Payouts table. exNav is the NAV right
// after the payout, which is the price a reinvested payout buys units at.
export interface Payout {
  date: string // YYYY-MM-DD payout date
  payout: number // PKR per unit
  exNav: number
}

// One end-of-day close of a PSX index.
export interface IndexEntry {
  date: string // YYYY-MM-DD
  close: number
}

export interface FundMeta {
  inceptionDate?: string
  expenseRatio?: number
  managementFee?: number
}

export type MetaFile = Record<string, FundMeta>
