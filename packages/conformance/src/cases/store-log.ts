import { getLogStore, logStoreDefinition, type StoredLog } from '@hozon/store-log'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

function log(timestamp: number, message: string, traceID?: string): StoredLog {
  return {
    timestamp,
    level: 'info',
    category: ['app'],
    message,
    properties: {},
    ...(traceID === undefined ? {} : { traceID, spanID: `span-${traceID}` }),
  }
}

export const storeLogCases: Array<ConformanceCase> = [
  {
    name: 'log store: ordering, cursor, filters and category prefix',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(logStoreDefinition)
      const store = await getLogStore(db)
      const logs = [
        { ...log(2, 'late', 'trace'), category: ['a', 'child'], level: 'warning' as const },
        { ...log(1, 'first', 'trace'), category: ['a', '😀'], level: 'warning' as const },
        { ...log(1, 'second', 'trace-2'), category: ['a'], level: 'info' as const },
        { ...log(0, 'before'), category: ['a'], level: 'warning' as const },
        { ...log(3, 'after'), category: ['a'], level: 'warning' as const },
        { ...log(1, 'unmatched', 'trace'), category: ['ab'], level: 'warning' as const },
      ]
      await store.addLogs(logs)
      const page = await store.queryLogs({ limit: 1, categoryPrefix: ['a'] })
      assert.deepEqual(page.logs, [logs[3]])
      assert.ok(page.cursor)
      const next = await store.queryLogs({ limit: 1, categoryPrefix: ['a'], cursor: page.cursor })
      assert.deepEqual(next.logs, [logs[1]])
      assert.ok(next.cursor)
      const last = await store.queryLogs({ limit: 1, categoryPrefix: ['a'], cursor: next.cursor })
      assert.deepEqual(last.logs, [logs[2]])
      assert.ok(last.cursor)
      const final = await store.queryLogs({ limit: 1, categoryPrefix: ['a'], cursor: last.cursor })
      assert.deepEqual(final.logs, [logs[0]])
      assert.ok(final.cursor)
      const end = await store.queryLogs({ limit: 1, categoryPrefix: ['a'], cursor: final.cursor })
      assert.deepEqual(end.logs, [logs[4]])
      assert.equal(end.cursor, undefined)
      assert.deepEqual(await store.getTraceLogs('trace'), [logs[1], logs[5], logs[0]])

      assert.deepEqual((await store.queryLogs({ limit: 10, levels: ['warning'] })).logs, [
        logs[3],
        logs[1],
        logs[5],
        logs[0],
        logs[4],
      ])
      assert.deepEqual((await store.queryLogs({ limit: 10, categoryPrefix: ['a'] })).logs, [
        logs[3],
        logs[1],
        logs[2],
        logs[0],
        logs[4],
      ])
      assert.deepEqual(
        (await store.queryLogs({ limit: 10, categoryPrefix: ['a'], levels: ['warning'] })).logs,
        [logs[3], logs[1], logs[0], logs[4]],
      )
      assert.deepEqual((await store.queryLogs({ limit: 10, from: 1 })).logs, [
        logs[1],
        logs[2],
        logs[5],
        logs[0],
        logs[4],
      ])
      assert.deepEqual((await store.queryLogs({ limit: 10, to: 1 })).logs, [
        logs[3],
        logs[1],
        logs[2],
        logs[5],
      ])
      assert.deepEqual((await store.queryLogs({ limit: 10, traceID: 'trace-2' })).logs, [logs[2]])
    },
  },
  {
    name: 'log store: JSON payloads round-trip',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(logStoreDefinition)
      const store = await getLogStore(db)
      const input: StoredLog = {
        ...log(1, 'json'),
        properties: { emoji: '🗄️保存', nested: { a: [1, { b: null }] }, long: 'x'.repeat(10_000) },
      }
      await store.addLogs([input])
      assert.deepEqual((await store.queryLogs({ limit: 10 })).logs, [input])
    },
  },
  {
    name: 'log store: retention preserves 2,000 trace IDs',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(logStoreDefinition)
      const store = await getLogStore(db)
      const keepTraceIDs = Array.from({ length: 2_000 }, (_, index) => `keep-${index}`)
      await store.addLogs([
        ...keepTraceIDs.map((traceID) => log(1, traceID, traceID)),
        log(1, 'delete', 'delete'),
      ])
      assert.equal(await store.deleteBefore(2, { keepTraceIDs }), 1)
      assert.equal((await store.queryLogs({ limit: 1_000 })).logs.length, 1_000)
      assert.deepEqual(await store.getTraceLogs('delete'), [])
    },
  },
  {
    name: 'log store: concurrent keep-set retention in one transaction',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(logStoreDefinition)
      const store = await getLogStore(db)
      await store.addLogs([log(1, 'a', 'a'), log(1, 'b', 'b'), log(1, 'c', 'c'), log(5, 'd', 'd')])
      // Keep-set calls in one transaction are serialized in call order.
      const counts = await db.withTransaction(async (tx) => {
        const txStore = await getLogStore(tx)
        return Promise.all([
          txStore.deleteBefore(2, { keepTraceIDs: ['a', 'b'] }),
          txStore.deleteBefore(2, { keepTraceIDs: ['a'] }),
        ])
      })
      assert.deepEqual(counts, [1, 1])
      assert.deepEqual(
        (await store.queryLogs({ limit: 10 })).logs.map((entry) => entry.message),
        ['a', 'd'],
      )
    },
  },
  {
    name: 'log store: concurrent keep-set retention rolls back, then succeeds again',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(logStoreDefinition)
      const store = await getLogStore(db)
      await store.addLogs([log(1, 'a', 'a'), log(1, 'b', 'b'), log(1, 'c', 'c')])
      const failure = new Error('abort retention')
      let counts: Array<number> = []
      let rejected: unknown
      try {
        await db.withTransaction(async (tx) => {
          const txStore = await getLogStore(tx)
          counts = await Promise.all([
            txStore.deleteBefore(2, { keepTraceIDs: ['a', 'b'] }),
            txStore.deleteBefore(2, { keepTraceIDs: ['a'] }),
          ])
          throw failure
        })
      } catch (error) {
        rejected = error
      }
      assert.equal(rejected, failure)
      assert.deepEqual(counts, [1, 1])
      assert.equal((await store.queryLogs({ limit: 10 })).logs.length, 3)
      const retried = await db.withTransaction(async (tx) => {
        const txStore = await getLogStore(tx)
        return Promise.all([
          txStore.deleteBefore(2, { keepTraceIDs: ['a'] }),
          txStore.deleteBefore(2, { keepTraceIDs: ['b'] }),
        ])
      })
      assert.deepEqual(retried, [2, 1])
      assert.equal((await store.queryLogs({ limit: 10 })).logs.length, 0)
    },
  },
]
