export interface Fund {
  fundId: string
  name: string
  amc: string
  nav: number
  offerPrice: number
  category: string
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
