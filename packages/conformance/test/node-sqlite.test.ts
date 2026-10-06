import { HozonDB, type StoreProvider } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test, vi } from 'vitest'

import { allCases, runConformance, summarize, transactionCases } from '../src/index.js'
import { defineVitestSuite } from '../src/vitest.js'

defineVitestSuite({
  name: 'node-sqlite',
  createAdapter: async () => new NodeSQLiteAdapter({ database: ':memory:' }),
})

test.each(['commit', 'rollback'] as const)(
  'hook timing conformance rejects %s hooks fired inside the transaction callback',
  async (phase) => {
    const original = HozonDB.prototype.withTransaction
    const mutation = vi
      .spyOn(HozonDB.prototype, 'withTransaction')
      .mockImplementation(async function <Stores extends Record<string, unknown>, R>(
        this: HozonDB,
        fn: (tx: StoreProvider<Stores>) => Promise<R>,
      ): Promise<R> {
        return original.bind(this)<Stores, R>(async (tx) => {
          const hooks: Array<() => void> = []
          tx[phase === 'commit' ? 'onCommit' : 'onRollback'] = (hook) => hooks.push(hook)
          try {
            const result = await fn(tx)
            if (phase === 'commit') for (const hook of hooks) hook()
            return result
          } catch (error) {
            if (phase === 'rollback') for (const hook of hooks) hook()
            throw error
          }
        })
      })
    try {
      const results = await runConformance({
        createAdapter: async () => new NodeSQLiteAdapter({ database: ':memory:' }),
        cases: transactionCases.filter((entry) =>
          entry.name.includes(phase === 'commit' ? 'onCommit runs' : 'onRollback runs'),
        ),
      })
      expect(results).toHaveLength(1)
      expect(results[0]?.ok).toBe(false)
      expect(results[0]?.error).toBe(`Expected ${phase}, received undefined`)
    } finally {
      mutation.mockRestore()
    }
  },
)

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
