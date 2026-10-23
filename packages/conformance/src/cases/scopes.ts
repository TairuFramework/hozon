import { type BaseStoreContext, sql, withKeyLock } from '@hozon/db'

import * as assert from '../assert.js'
import type { ConformanceCase } from '../runner.js'

type Api = { read(): Promise<string | null>; write(value: string): Promise<void> }

export const scopeCases: Array<ConformanceCase> = [
  ...[false, true].map(
    (locked): ConformanceCase => ({
      name: `scopes: release invalidates parent loaders (lock: ${locked})`,
      async run(ctx) {
        const db = ctx.db()
        db.register<{ scope_rows: { id: string; value: string } }, Api>({
          name: 'rows',
          migrations: {
            '0-init': {
              async up(query) {
                await query.schema
                  .createTable('scope_rows')
                  .addColumn('id', 'text', (column) => column.primaryKey())
                  .addColumn('value', 'text')
                  .execute()
              },
            },
          },
          createAPI(query, _adapter, context) {
            const loader = context.createLoader<string, string>({
              maxBatchSize: 500,
              async load(keys) {
                const rows = await query
                  .selectFrom('scope_rows')
                  .selectAll()
                  .where('id', 'in', keys)
                  .execute()
                return new Map(rows.map((row) => [row.id, row.value]))
              },
            })
            return {
              read: () => loader.load('a'),
              async write(value) {
                loader.dispatch()
                await query
                  .insertInto('scope_rows')
                  .values({ id: 'a', value })
                  .onConflict((conflict) => conflict.column('id').doUpdateSet({ value }))
                  .execute()
                loader.clear('a')
              },
            }
          },
        })
        await (await db.getStore<Api>('rows')).write('v1')
        await db.withTransaction<{ rows: Api }, void>(async (tx) => {
          const parent = await tx.getStore('rows')
          assert.equal(await parent.read(), 'v1')
          assert.ok(tx.withSavepoint)
          await tx.withSavepoint<{ rows: Api }, void>(async (sp) => {
            if (locked) {
              await withKeyLock(sp, 'scope_rows', ['a'], async (scope) => {
                await ((await scope.getStore('rows')) as Api).write('v2')
              })
            } else await (await sp.getStore('rows')).write('v2')
          })
          assert.equal(await parent.read(), 'v2')
        })
      },
    }),
  ),
  ...[false, true].map(
    (rollback): ConformanceCase => ({
      name: `scopes: released provider child forwards hooks (rollback: ${rollback})`,
      async run(ctx) {
        const db = ctx.db()
        const events: Array<string> = []
        const transaction = db.withTransaction(async (tx) => {
          assert.ok(tx.withSavepoint)
          const released = await tx.withSavepoint(async (sp) => sp)
          assert.ok(released.withSavepoint)
          await released.withSavepoint(async (child) => {
            child.onCommit(() => events.push('commit'))
            child.onRollback(() => events.push('rollback'))
          })
          assert.deepEqual(events, [])
          if (rollback) throw new Error('outer rollback')
        })
        if (rollback) await assert.rejects(() => transaction, 'outer rollback')
        else await transaction
        assert.deepEqual(events, [rollback ? 'rollback' : 'commit'])
      },
    }),
  ),
  ...[false, true].map(
    (savepoint): ConformanceCase => ({
      name: `scopes: onClose uses root SQL (savepoint: ${savepoint})`,
      async run(ctx) {
        const db = ctx.db()
        let value: number | undefined
        type Sqlapi = { read(): Promise<number> }
        db.register({
          name: 'sql',
          migrations: {},
          createAPI: (query) => ({
            async read() {
              const result = await sql<{ value: number }>`select 1 as value`.execute(query)
              const row = result.rows[0]
              if (!row) throw new Error('Missing SQL result')
              return row.value
            },
          }),
        })
        db.register({
          name: 'close',
          migrations: {},
          createAPI: async (_query, _adapter, context: BaseStoreContext) => {
            const root = (await context.root.getStore('sql')) as Sqlapi
            context.onClose(async () => {
              value = await root.read()
            })
            return context
          },
        })
        await db.withTransaction(async (tx) => {
          if (savepoint) {
            assert.ok(tx.withSavepoint)
            await tx.withSavepoint(async (sp) => {
              await sp.getStore('close')
            })
          } else await tx.getStore('close')
        })
        await db.close()
        assert.equal(value, 1)
      },
    }),
  ),
]
