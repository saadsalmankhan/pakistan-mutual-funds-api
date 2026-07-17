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
