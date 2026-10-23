import { runConformance, searchCases } from '@hozon/conformance'
import { describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'

describe.each(backends())('$name search', (backend) => {
  for (const entry of searchCases) {
    test(entry.name, async () => {
      const results = await runConformance({
        createAdapter: async () => {
          const adapter = await backend.createAdapter()
          expect(adapter.search).toBeDefined()
          return adapter
        },
        cleanup: () => backend.cleanup(),
        cases: [entry],
      })
      expect(results).toEqual([{ name: entry.name, ok: true }])
    }, 20_000)
  }
})
