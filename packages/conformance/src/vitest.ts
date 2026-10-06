import { describe, test } from 'vitest'

import { allCases } from './index.js'
import { type ConformanceContext, runConformance } from './runner.js'

export function defineVitestSuite(params: ConformanceContext & { name: string }): void {
  describe(params.name, () => {
    for (const entry of allCases) {
      test(entry.name, async () => {
        const [result] = await runConformance({ ...params, cases: [entry] })
        if (!result?.ok) throw new Error(result?.error ?? 'Missing conformance result')
      })
    }
  })
}
