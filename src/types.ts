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
  date: string // YYYY-MM-DD, Asia/Karachi — the date the NAV was scraped
  nav: number
  offerPrice: number
}

export interface FundMeta {
  inceptionDate?: string
  expenseRatio?: number
  managementFee?: number
}

export type MetaFile = Record<string, FundMeta>
