import { SavepointOverlapError } from '@hozon/db'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

type RowsAPI = { insert(id: string): Promise<void>; list(): Promise<Array<string>> }
type Stores = { first: RowsAPI; second: RowsAPI }

function setup(ctx: CaseContext) {
  const db = ctx.db()
  for (const name of ['first', 'second']) {
    const table = `conformance_${name}`
    db.register<Record<string, { id: string }>, RowsAPI>({
      name,
      migrations: {
        '0-init': {
          async up(query) {
            await query.schema
              .createTable(table)
              .addColumn('id', 'text', (column) => column.primaryKey())
              .execute()
          },
        },
      },
      createAPI: (query) => ({
        async insert(id) {
          await query.insertInto(table).values({ id }).execute()
        },
        async list() {
          const rows = await query.selectFrom(table).select('id').orderBy('id').execute()
          return rows.map((row) => row.id)
        },
      }),
    })
  }
  return db
}

export const transactionCases: Array<ConformanceCase> = [
  {
    name: 'transactions: cross-store commit',
    async run(ctx) {
      const db = setup(ctx)
      const result = await db.withTransaction<Stores, string>(async (tx) => {
        await (await tx.getStore('first')).insert('a')
        await (await tx.getStore('second')).insert('b')
        return 'committed'
      })
      assert.equal(result, 'committed')
      assert.deepEqual(await (await db.getStore<RowsAPI>('first')).list(), ['a'])
      assert.deepEqual(await (await db.getStore<RowsAPI>('second')).list(), ['b'])
    },
  },
  {
    name: 'transactions: second-store SQL failure rolls back both stores',
    async run(ctx) {
      const db = setup(ctx)
      await assert.rejects(
        () =>
          db.withTransaction<Stores, void>(async (tx) => {
            await (await tx.getStore('first')).insert('a')
            const second = await tx.getStore('second')
            await second.insert('b')
            await second.insert('b')
          }),
        Error,
      )
      assert.deepEqual(await (await db.getStore<RowsAPI>('first')).list(), [])
      assert.deepEqual(await (await db.getStore<RowsAPI>('second')).list(), [])
    },
  },
  {
    name: 'transactions: nested transactions run inline and inherit rollback',
    async run(ctx) {
      const db = setup(ctx)
      await assert.rejects(
        () =>
          db.withTransaction<Stores, void>(async (tx) => {
            await tx.withTransaction<Stores, void>(async (nested) => {
              assert.equal(nested, tx)
              await (await nested.getStore('first')).insert('nested')
            })
            assert.deepEqual(await (await tx.getStore('first')).list(), ['nested'])
            throw new Error('outer rollback')
          }),
        'outer rollback',
      )
      assert.deepEqual(await (await db.getStore<RowsAPI>('first')).list(), [])
    },
  },
  {
    name: 'transactions: savepoint SQL rollback preserves outer writes and hooks',
    async run(ctx) {
      const db = setup(ctx)
      const hooks: Array<string> = []
      await db.withTransaction<Stores, void>(async (tx) => {
        const first = await tx.getStore('first')
        await first.insert('before')
        assert.ok(tx.withSavepoint)
        const withSavepoint = tx.withSavepoint.bind(tx)
        await assert.rejects(
          () =>
            withSavepoint<Stores, void>(async (scope) => {
              scope.onCommit(() => hooks.push('discarded-commit'))
              scope.onRollback(() => hooks.push('savepoint-rollback'))
              const store = await scope.getStore('first')
              await store.insert('discarded')
              await store.insert('before')
            }),
          Error,
        )
        assert.deepEqual(hooks, ['savepoint-rollback'])
        assert.deepEqual(await first.list(), ['before'])
        await first.insert('after')
        await tx.withSavepoint<Stores, void>(async (scope) => {
          await (await scope.getStore('second')).insert('released')
          scope.onCommit(() => hooks.push('released-commit'))
        })
        assert.deepEqual(hooks, ['savepoint-rollback'])
      })
      assert.deepEqual(await (await db.getStore<RowsAPI>('first')).list(), ['after', 'before'])
      assert.deepEqual(await (await db.getStore<RowsAPI>('second')).list(), ['released'])
      assert.deepEqual(hooks, ['savepoint-rollback', 'released-commit'])
    },
  },
  {
    name: 'transactions: overlapping sibling savepoints reject',
    async run(ctx) {
      const db = setup(ctx)
      await db.withTransaction<Stores, void>(async (tx) => {
        assert.ok(tx.withSavepoint)
        const withSavepoint = tx.withSavepoint.bind(tx)
        const first = withSavepoint<Stores, void>(async (scope) => {
          await (await scope.getStore('first')).insert('kept')
        })
        try {
          await assert.rejects(
            () =>
              withSavepoint(async () => {
                throw new Error('overlap callback must not run')
              }),
            SavepointOverlapError,
          )
        } finally {
          await first
        }
        await withSavepoint<Stores, void>(async (scope) => {
          await (await scope.getStore('second')).insert('later')
        })
      })
      assert.deepEqual(await (await db.getStore<RowsAPI>('first')).list(), ['kept'])
      assert.deepEqual(await (await db.getStore<RowsAPI>('second')).list(), ['later'])
    },
  },
  {
    name: 'transactions: onCommit runs after committed writes',
    async run(ctx) {
      const db = setup(ctx)
      const hooks: Array<string> = []
      let read: Promise<Array<string>> | undefined
      await db.withTransaction<Stores, void>(async (tx) => {
        tx.onCommit(() => {
          hooks.push('commit')
          read = db.getStore<RowsAPI>('first').then((store) => store.list())
        })
        tx.onRollback(() => hooks.push('unexpected-rollback'))
        await (await tx.getStore('first')).insert('committed')
        assert.deepEqual(hooks, [])
      })
      assert.deepEqual(hooks, ['commit'])
      assert.deepEqual(await read, ['committed'])
    },
  },
  {
    name: 'transactions: onRollback runs after reverted writes',
    async run(ctx) {
      const db = setup(ctx)
      const hooks: Array<string> = []
      let read: Promise<Array<string>> | undefined
      await assert.rejects(
        () =>
          db.withTransaction<Stores, void>(async (tx) => {
            tx.onRollback(() => {
              hooks.push('rollback')
              read = db.getStore<RowsAPI>('first').then((store) => store.list())
            })
            tx.onCommit(() => hooks.push('unexpected-commit'))
            await (await tx.getStore('first')).insert('discarded')
            assert.deepEqual(hooks, [])
            throw new Error('rollback')
          }),
        'rollback',
      )
      assert.deepEqual(hooks, ['rollback'])
      assert.deepEqual(await read, [])
    },
  },
  {
    name: 'transactions: hook errors are isolated on commit and rollback',
    async run(ctx) {
      const db = setup(ctx)
      const hooks: Array<string> = []
      const result = await db.withTransaction<Stores, string>(async (tx) => {
        tx.onCommit(() => {
          hooks.push('throwing-commit')
          throw new Error('commit hook failed')
        })
        tx.onCommit(() => hooks.push('later-commit'))
        await (await tx.getStore('first')).insert('kept')
        return 'committed'
      })
      assert.equal(result, 'committed')
      await assert.rejects(
        () =>
          db.withTransaction<Stores, void>(async (tx) => {
            tx.onRollback(() => {
              hooks.push('throwing-rollback')
              throw new Error('rollback hook failed')
            })
            tx.onRollback(() => hooks.push('later-rollback'))
            await (await tx.getStore('first')).insert('discarded')
            throw new Error('original rollback')
          }),
        'original rollback',
      )
      assert.deepEqual(hooks, [
        'throwing-commit',
        'later-commit',
        'throwing-rollback',
        'later-rollback',
      ])
      assert.deepEqual(await (await db.getStore<RowsAPI>('first')).list(), ['kept'])
    },
  },
]
