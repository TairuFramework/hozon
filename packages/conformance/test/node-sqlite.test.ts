import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import { allCases, runConformance, summarize } from '../src/index.js'
import { defineVitestSuite } from '../src/vitest.js'

defineVitestSuite({
  name: 'node-sqlite',
  createAdapter: async () => new NodeSQLiteAdapter({ database: ':memory:' }),
})

test('default portable runner executes every case successfully', async () => {
  expect(allCases.length).toBeGreaterThan(0)
  expect(new Set(allCases.map((entry) => entry.name)).size).toBe(allCases.length)
  const results = await runConformance({
    createAdapter: async () => new NodeSQLiteAdapter({ database: ':memory:' }),
  })
  expect(results.filter((entry) => !entry.ok)).toEqual([])
  expect(results.map((entry) => entry.name)).toEqual(allCases.map((entry) => entry.name))
  expect(summarize(results).line('Conformance')).toBe(
    `Conformance: OK ${allCases.length}/${allCases.length}`,
  )
})
