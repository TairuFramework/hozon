import type { Adapter } from '@hozon/adapter'
import { HozonDB, type HozonDBParams } from '@hozon/db'

import { encodingCases } from './cases/encoding.js'
import { lifecycleCases } from './cases/lifecycle.js'
import { migrationCases } from './cases/migrations.js'
import { seamCases } from './cases/seams.js'
import { transactionCases } from './cases/transactions.js'

export type ConformanceContext = {
  createAdapter: () => Promise<Adapter>
  cleanup?: () => Promise<void>
}
export type CaseContext = {
  adapter: Adapter
  db: (params?: Partial<HozonDBParams>) => HozonDB
}
export type ConformanceCase = { name: string; run(ctx: CaseContext): Promise<void> }
export type ConformanceResult = { name: string; ok: boolean; error?: string }

export const allCases: Array<ConformanceCase> = [
  ...encodingCases,
  ...seamCases,
  ...migrationCases,
  ...transactionCases,
  ...lifecycleCases,
]

export async function runConformance(
  params: ConformanceContext & { cases?: Array<ConformanceCase> },
): Promise<Array<ConformanceResult>> {
  const results: Array<ConformanceResult> = []
  for (const entry of params.cases ?? allCases) {
    const errors: Array<string> = []
    const databases: Array<HozonDB> = []
    let adapter: Adapter | undefined
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    await attempt(async () => {
      adapter = await params.createAdapter()
      const caseAdapter = adapter
      await entry.run({
        adapter: caseAdapter,
        db: (options) => {
          const db = new HozonDB({ ...options, adapter: caseAdapter })
          databases.push(db)
          return db
        },
      })
    })
    for (const db of databases) await attempt(() => db.close())
    // HozonDB owns its adapter; close directly only when no database was created.
    if (databases.length === 0 && adapter?.close) {
      const close = adapter.close.bind(adapter)
      await attempt(close)
    }
    if (params.cleanup) await attempt(params.cleanup)
    results.push(
      errors.length === 0
        ? { name: entry.name, ok: true }
        : { name: entry.name, ok: false, error: errors.join('; ') },
    )
  }
  return results
}

export function summarize(results: Array<ConformanceResult>) {
  const passed = results.filter((result) => result.ok).length
  const total = results.length
  const ok = passed === total
  return {
    ok,
    passed,
    total,
    line: (label: string) => `${label}: ${ok ? 'OK' : 'FAIL'} ${passed}/${total}`,
  }
}
