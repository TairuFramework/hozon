import { Kysely, sql } from '@hozon/db'

import * as assert from '../assert.js'
import type { ConformanceCase } from '../runner.js'

export const nativeContractCases: Array<ConformanceCase> = [
  {
    name: 'native contract: raw outside read sees committed state during a write',
    capabilities: { admissionControl: true, concurrentReaders: true },
    async run(ctx) {
      assert.ok(ctx.admissionControl)
      const { sqlite, db } = await ctx.admissionControl(ctx.adapter)
      await sqlite.execute(db, null, 'CREATE TABLE visibility (value INTEGER)', [], 'write')
      await sqlite.execute(db, null, 'INSERT INTO visibility VALUES (1)', [], 'write')
      const holder = await sqlite.beginWrite(db)
      try {
        await sqlite.execute(db, holder.txID, 'INSERT INTO visibility VALUES (2)', [], 'write')
        assert.deepEqual(
          (
            await sqlite.execute(
              db,
              holder.txID,
              'SELECT value FROM visibility ORDER BY value',
              [],
              'read',
            )
          ).rows,
          [[1], [2]],
        )
        assert.deepEqual(
          (await sqlite.execute(db, null, 'SELECT value FROM visibility', [], 'read')).rows,
          [[1]],
        )
        await sqlite.commit(db, holder.txID)
      } catch (error) {
        await sqlite.rollback(db, holder.txID)
        throw error
      }
      assert.deepEqual(
        (await sqlite.execute(db, null, 'SELECT value FROM visibility ORDER BY value', [], 'read'))
          .rows,
        [[1], [2]],
      )
    },
  },
  {
    name: 'native contract: close rolls back active writer, rejects waiter and is idempotent',
    capabilities: { admissionControl: true },
    async run(ctx) {
      assert.ok(ctx.admissionControl)
      const { sqlite, db } = await ctx.admissionControl(ctx.adapter)
      await sqlite.execute(db, null, 'CREATE TABLE shutdown (value INTEGER)', [], 'write')
      const holder = await sqlite.beginWrite(db)
      await sqlite.execute(db, holder.txID, 'INSERT INTO shutdown VALUES (1)', [], 'write')
      const pending = sqlite.beginWrite(db).then(
        () => 'unexpected grant',
        (error: unknown) => error,
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      await sqlite.close(db)
      const outcome = await pending
      assert.ok(outcome instanceof Error)
      assert.ok(/closed|stopped/i.test(outcome.message))
      await assert.rejects(() => sqlite.execute(db, holder.txID, 'SELECT 1', [], 'read'), 'closed')
      await sqlite.close(db)
    },
  },
  {
    name: 'native contract: adapter preserves i64, blobs, null and write metadata',
    capabilities: { admissionControl: true },
    async run(ctx) {
      const query = new Kysely({ dialect: ctx.adapter.dialect })
      try {
        await sql`CREATE TABLE native_fidelity (id INTEGER PRIMARY KEY, large INTEGER, blob BLOB, absent, flag, json)`.execute(
          query,
        )
        const blob = new Uint8Array([0, 127, 255])
        const result =
          await sql`INSERT INTO native_fidelity VALUES (NULL, ${9223372036854775807n}, ${blob}, ${null}, ${true}, ${{ nested: ['雪', 1] }}) RETURNING *`.execute(
            query,
          )
        assert.equal(result.numAffectedRows, 1n)
        assert.equal(result.insertId, 1n)
        assert.deepEqual(result.rows, [
          {
            id: 1,
            large: 9223372036854775807n,
            blob,
            absent: null,
            flag: 1,
            json: '{"nested":["雪",1]}',
          },
        ])
        const update =
          await sql`UPDATE native_fidelity SET large = ${2147483648n}, flag = ${false}`.execute(
            query,
          )
        assert.equal(update.numAffectedRows, 1n)
        assert.deepEqual((await sql`SELECT large, flag FROM native_fidelity`.execute(query)).rows, [
          { large: 2147483648n, flag: 0 },
        ])
        assert.equal(
          (await sql`DELETE FROM native_fidelity RETURNING id`.execute(query)).numAffectedRows,
          1n,
        )
      } finally {
        await query.destroy()
      }
    },
  },
]
