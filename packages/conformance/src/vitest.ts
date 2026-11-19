import { describe, test } from 'vitest'

import { supportsCase } from './capabilities.js'
import { allCases } from './index.js'
import { type ConformanceContext, runConformance } from './runner.js'

export function defineVitestSuite(params: ConformanceContext & { name: string }): void {
  describe(params.name, () => {
    for (const entry of allCases) {
      test.skipIf(!supportsCase(entry, params.capabilities))(entry.name, async () => {
        const [result] = await runConformance({ ...params, cases: [entry] })
        if (!result?.ok) throw new Error(result?.error ?? 'Missing conformance result')
      })
    }
  })
}
