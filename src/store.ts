import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Fund, FundStore } from './types.js'

const DATA_FILE = process.env.DATA_FILE || './data/funds.json'

export async function readStore(): Promise<FundStore | null> {
  try {
    const raw = await readFile(DATA_FILE, 'utf-8')
    return JSON.parse(raw) as FundStore
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeStore(funds: Fund[]): Promise<FundStore> {
  const store: FundStore = { funds, updatedAt: new Date().toISOString() }
  await mkdir(dirname(DATA_FILE), { recursive: true })
  await writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8')
  return store
}
