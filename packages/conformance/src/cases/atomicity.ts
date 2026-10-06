import { getLogStore, logStoreDefinition } from '@hozon/store-log'
import { getTelemetryStore, telemetryStoreDefinition } from '@hozon/store-telemetry'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

export const atomicityCases: Array<ConformanceCase> = [
  {
    name: 'stores: cross-store writes roll back atomically',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(logStoreDefinition)
      db.register(telemetryStoreDefinition)
      await assert.rejects(
        () =>
          db.withTransaction(async (tx) => {
            await (await getLogStore(tx)).addLogs([
              {
                timestamp: 1,
                level: 'info',
                category: ['atomic'],
                message: 'rolled back',
                properties: {},
              },
            ])
            await (await getTelemetryStore(tx)).addSpans([
              {
                traceID: 'trace',
                spanID: 'span',
                name: 'rolled back',
                kind: 0,
                startTime: 1,
                endTime: 2,
                status: { code: 0 },
                attributes: {},
                events: [],
                links: [],
              },
            ])
            throw new Error('rollback both stores')
          }),
        'rollback both stores',
      )
      assert.deepEqual((await (await getLogStore(db)).queryLogs({ limit: 10 })).logs, [])
      assert.deepEqual(await (await getTelemetryStore(db)).getSpans('trace'), [])
    },
  },
  {
    name: 'stores: failed telemetry delete rolls back log deletion',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(logStoreDefinition)
      db.register(telemetryStoreDefinition)
      const logs = await getLogStore(db)
      const telemetry = await getTelemetryStore(db)
      await logs.addLogs([
        {
          traceID: 'trace',
          spanID: 'span',
          timestamp: 1,
          level: 'info',
          category: ['atomic'],
          message: 'preserved',
          properties: {},
        },
      ])
      await telemetry.addSpans([
        {
          traceID: 'trace',
          spanID: 'span',
          name: 'existing',
          kind: 0,
          startTime: 1,
          endTime: 2,
          status: { code: 0 },
          attributes: {},
          events: [],
          links: [],
        },
      ])
      await assert.rejects(
        () =>
          db.withTransaction(async (tx) => {
            await (await getLogStore(tx)).deleteByTrace(['trace'])
            const scoped = await getTelemetryStore(tx)
            const failing = {
              ...scoped,
              deleteByTrace: async (_traceIDs: Array<string>) => {
                throw new Error('telemetry delete failed')
              },
            }
            await failing.deleteByTrace(['trace'])
          }),
        'telemetry delete failed',
      )
      assert.deepEqual((await logs.queryLogs({ limit: 10 })).logs.length, 1)
      assert.equal((await telemetry.getSpans('trace')).length, 1)
    },
  },
]
