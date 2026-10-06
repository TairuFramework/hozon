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
        { ...log(1, 'second', 'trace'), category: ['a'], level: 'warning' as const },
        { ...log(0, 'unmatched'), category: ['ab'] },
      ]
      await store.addLogs(logs)
      const page = await store.queryLogs({ limit: 2, categoryPrefix: ['a'], levels: ['warning'] })
      assert.deepEqual(page.logs, [logs[1], logs[2]])
      assert.ok(page.cursor)
      const next = await store.queryLogs({ limit: 2, categoryPrefix: ['a'], cursor: page.cursor })
      assert.deepEqual(next.logs, [logs[0]])
      assert.deepEqual(await store.getTraceLogs('trace'), [logs[1], logs[2], logs[0]])
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
]
