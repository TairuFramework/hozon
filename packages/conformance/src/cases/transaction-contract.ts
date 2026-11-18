import { type BatchLoader, type HozonDB, type StoreProvider, withKeyLocks } from '@hozon/db'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

type Row = { id: string; version: number; value: string }
type Tables = { contract_rows: Row }
type RowsAPI = {
  insert(id: string): Promise<void>
  list(): Promise<Array<string>>
  write(row: Row): Promise<{ changed: boolean }>
  read(id: string): Promise<Row | undefined>
  loader: BatchLoader<string, string>
}
type Stores = { rows: RowsAPI }
export type Fixture = { db: HozonDB; root: RowsAPI }

async function setup(ctx: CaseContext): Promise<Fixture> {
  const db = ctx.db()
  db.register<Tables, RowsAPI>({
    name: 'rows',
    sync: { contract_rows: { key: ['id'], compare: ['version'] } },
    migrations: {
      '0-init': {
        async up(query) {
          await query.schema
            .createTable('contract_rows')
            .addColumn('id', 'text', (column) => column.primaryKey())
            .addColumn('version', 'integer', (column) => column.notNull())
            .addColumn('value', 'text', (column) => column.notNull())
            .execute()
        },
      },
    },
    createAPI: (query, _adapter, context) => ({
      async insert(id) {
        await query.insertInto('contract_rows').values({ id, version: 1, value: id }).execute()
      },
      async list() {
        const rows = await query.selectFrom('contract_rows').select('id').orderBy('id').execute()
        return rows.map((row) => row.id)
      },
      write: (row) => context.compareWrite('contract_rows', row),
      read: (id) =>
        query.selectFrom('contract_rows').selectAll().where('id', '=', id).executeTakeFirst(),
      loader: context.createLoader({
        maxBatchSize: 500,
        load: (keys: Array<string>) =>
          query
            .selectFrom('contract_rows')
            .select(['id', 'value'])
            .where('id', 'in', keys)
            .execute()
            .then((rows) => new Map(rows.map((row) => [row.id, row.value]))),
      }),
    }),
  })
  await db.migrate()
  return { db, root: await db.getStore<RowsAPI>('rows') }
}

// Observe real BEGIN calls without replacing their behavior.
async function setupCountingBegins(ctx: CaseContext) {
  const dialect = ctx.adapter.dialect
  const createDriver = dialect.createDriver
  let begins = 0
  dialect.createDriver = function () {
    const driver = createDriver.call(this)
    const begin = driver.beginTransaction.bind(driver)
    driver.beginTransaction = async (...args) => {
      begins++
      await begin(...args)
    }
    return driver
  }
  let fixture: Fixture
  try {
    fixture = await setup(ctx)
  } finally {
    dialect.createDriver = createDriver
  }
  begins = 0
  return { fixture, beginCount: () => begins }
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let cancel = () => {}
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} blocked for 1000 ms`)), 1000)
        cancel = () => clearTimeout(timer)
      }),
    ])
  } finally {
    cancel()
  }
}

export const transactionContractCases: Array<ConformanceCase> = [
  {
    name: 'transaction contract: queued writer waits, active tx proceeds',
    async run(ctx) {
      const { db, root } = await setup(ctx)
      const entered = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const events: Array<string> = []
      const a = db.withTransaction<Stores, void>(async (tx) => {
        entered.resolve()
        await proceed.promise
        const rows = await tx.getStore('rows')
        for (const id of ['a1', 'a2', 'a3']) await rows.insert(id)
        events.push('a finished')
      })
      await entered.promise
      const b = db.withTransaction<Stores, void>(async (tx) => {
        events.push('b entered')
        const rows = await tx.getStore('rows')
        assert.deepEqual(await rows.list(), ['a1', 'a2', 'a3'])
        await rows.insert('b')
      })
      // Observe rejection immediately while A still owns the writer.
      const settled = Promise.allSettled([a, b])
      try {
        await turn()
        assert.deepEqual(events, [])
      } finally {
        proceed.resolve()
      }
      const outcomes = await within(settled, 'queued writers')
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
      assert.deepEqual(events, ['a finished', 'b entered'])
      assert.deepEqual(await root.list(), ['a1', 'a2', 'a3', 'b'])
    },
  },
  {
    name: 'transaction contract: nested provider runs inline',
    async run(ctx) {
      const { fixture, beginCount } = await setupCountingBegins(ctx)
      const { db, root } = fixture
      await assert.rejects(
        () =>
          within(
            db.withTransaction<Stores, void>(async (tx) => {
              await tx.withTransaction<Stores, void>(async (nested) => {
                assert.equal(nested, tx)
                await (await nested.getStore('rows')).insert('inner')
              })
              assert.deepEqual(await (await tx.getStore('rows')).list(), ['inner'])
              throw new Error('outer rollback')
            }),
            'nested provider',
          ),
        'outer rollback',
      )
      assert.equal(beginCount(), 1)
      assert.deepEqual(await root.list(), [])
    },
  },
  {
    name: 'transaction contract: savepoint rollback clears loaders',
    async run(ctx) {
      const { db, root } = await setup(ctx)
      await root.write({ id: 'x', version: 1, value: 'before' })
      await db.withTransaction<Stores, void>(async (tx) => {
        const rows = await tx.getStore('rows')
        assert.equal(await rows.loader.load('x'), 'before')
        assert.ok(tx.withSavepoint)
        const savepoint = tx.withSavepoint.bind(tx)
        await assert.rejects(
          () =>
            savepoint<Stores, void>(async (sp) => {
              const scoped = await sp.getStore('rows')
              await scoped.write({ id: 'x', version: 2, value: 'inside' })
              // Populate both registries with the value that must be discarded.
              rows.loader.clear('x')
              assert.equal(await rows.loader.load('x'), 'inside')
              assert.equal(await scoped.loader.load('x'), 'inside')
              throw new Error('savepoint rollback')
            }),
          'savepoint rollback',
        )
        assert.equal(await rows.loader.load('x'), 'before')
      })
      assert.equal((await root.read('x'))?.value, 'before')
    },
  },
  ...([false, true] as const).map(
    (bound): ConformanceCase => ({
      name: `transaction contract: withKeyLocks on ${bound ? 'bound provider reuses it' : 'unbound provider opens one transaction'}`,
      async run(ctx) {
        const { fixture, beginCount } = await setupCountingBegins(ctx)
        const { db, root } = fixture
        const lock = async (provider: StoreProvider, rollback = false) => {
          await withKeyLocks(provider, 'contract_rows', [['a'], ['b']], async (locked) => {
            assert.equal(locked.isTransactionBound, true)
            if (bound) assert.equal(locked.transactionRoot, provider.transactionRoot)
            const scoped = locked as StoreProvider<Stores>
            await (await scoped.getStore('rows')).insert(rollback ? 'rolled-back' : 'locked')
            if (rollback) throw new Error('locked rollback')
          })
        }
        if (bound) {
          await assert.rejects(
            () =>
              db.withTransaction(async (tx) => {
                await lock(tx)
                assert.equal(beginCount(), 1)
                throw new Error('locked rollback')
              }),
            'locked rollback',
          )
          assert.deepEqual(await root.list(), [])
        } else {
          await lock(db)
          assert.deepEqual(await root.list(), ['locked'])
        }
        assert.equal(beginCount(), 1)
        if (!bound) {
          await assert.rejects(() => lock(db, true), 'locked rollback')
          assert.equal(beginCount(), 2)
          assert.deepEqual(await root.list(), ['locked'])
        }
      },
    }),
  ),
  {
    name: 'transaction contract: compareWrite uses supplied connection',
    capabilities: { concurrentReaders: true },
    async run(ctx) {
      const { db, root } = await setup(ctx)
      const original = { id: 'x', version: 1, value: 'committed' }
      const updated = { id: 'x', version: 2, value: 'uncommitted' }
      await root.write(original)
      let outside: Promise<Row | undefined> | undefined
      try {
        await db.withTransaction<Stores, void>(async (tx) => {
          const rows = await tx.getStore('rows')
          assert.deepEqual(await rows.write(updated), { changed: true })
          assert.deepEqual(await rows.read('x'), updated)
          outside = root.read('x')
          assert.deepEqual(await within(outside, 'outside compareWrite reader'), original)
        })
      } finally {
        // On failure the callback rolls back, freeing a queued single-connection read.
        if (outside) await within(outside, 'outside reader cleanup')
      }
      assert.deepEqual(await root.read('x'), updated)
    },
  },
  ...([false, true] as const).map(
    (rollback): ConformanceCase => ({
      name: `transaction contract: mapConcurrent inside tx ${rollback ? 'rolls back all rows on one throw' : 'commits all rows'}`,
      async run(ctx) {
        const { db, root } = await setup(ctx)
        const ids = Array.from({ length: 10 }, (_, index) => `branch-${index}`)
        const run = () =>
          db.withTransaction<Stores, void>(async (tx) => {
            const rows = await tx.getStore('rows')
            const written = Promise.withResolvers<void>()
            let count = 0
            await Promise.all(
              ids.map(async (id) => {
                await rows.insert(id)
                if (++count === 10) written.resolve()
                await written.promise
                if (rollback && id === 'branch-9') throw new Error('branch failed')
              }),
            )
            assert.deepEqual(await rows.list(), ids)
          })
        if (rollback)
          await assert.rejects(() => within(run(), 'concurrent branches'), 'branch failed')
        else await within(run(), 'concurrent branches')
        assert.deepEqual(await root.list(), rollback ? [] : ids)
      },
    }),
  ),
  {
    name: 'transaction contract: commit hook may write',
    async run(ctx) {
      const { db, root } = await setup(ctx)
      let followup: Promise<void> | undefined
      await db.withTransaction<Stores, void>(async (tx) => {
        await (await tx.getStore('rows')).insert('first')
        tx.onCommit(() => {
          followup = db.withTransaction<Stores, void>(async (next) => {
            const rows = await next.getStore('rows')
            assert.deepEqual(await rows.list(), ['first'])
            await rows.insert('hook')
          })
        })
      })
      assert.ok(followup)
      await within(followup, 'commit hook writer')
      assert.deepEqual(await root.list(), ['first', 'hook'])
    },
  },
  {
    name: 'transaction contract: reads outside tx see last committed state',
    capabilities: { concurrentReaders: true },
    async run(ctx) {
      const { db, root } = await setup(ctx)
      await root.insert('committed')
      let outside: Promise<Array<string>> | undefined
      try {
        await db.withTransaction<Stores, void>(async (tx) => {
          const rows = await tx.getStore('rows')
          await rows.insert('pending')
          assert.deepEqual(await rows.list(), ['committed', 'pending'])
          outside = root.list()
          assert.deepEqual(await within(outside, 'outside reader'), ['committed'])
        })
      } finally {
        if (outside) await within(outside, 'outside reader cleanup')
      }
      assert.deepEqual(await root.list(), ['committed', 'pending'])
    },
  },
  ...([false, true] as const).map(
    (rollback): ConformanceCase => ({
      name: `transaction contract: outside read queues until ${rollback ? 'rollback and sees pre-transaction state' : 'commit and sees committed rows'}`,
      capabilities: { concurrentReaders: false },
      async run(ctx) {
        const { db, root } = await setup(ctx)
        const original = { id: 'x', version: 1, value: 'before' }
        const updated = { id: 'x', version: 2, value: 'after' }
        await root.write(original)
        let outside: Promise<Row | undefined> | undefined
        let settled = false
        const writer = db.withTransaction<Stores, void>(async (tx) => {
          const rows = await tx.getStore('rows')
          assert.deepEqual(await rows.write(updated), { changed: true })
          assert.deepEqual(await rows.read('x'), updated)
          outside = root.read('x')
          // Observe either outcome immediately, including unexpected rejection.
          void outside.then(
            () => {
              settled = true
            },
            () => {
              settled = true
            },
          )
          await turn()
          assert.equal(settled, false)
          // The queued root read must not prevent more active commands.
          await rows.insert('pending')
          assert.deepEqual(await rows.list(), ['pending', 'x'])
          if (rollback) throw new Error('writer rollback')
        })
        try {
          if (rollback)
            await assert.rejects(() => within(writer, 'active writer'), 'writer rollback')
          else await within(writer, 'writer commit')
          assert.ok(outside)
          assert.deepEqual(
            await within(outside, 'queued outside reader'),
            rollback ? original : updated,
          )
          assert.deepEqual(await root.list(), rollback ? ['x'] : ['pending', 'x'])
        } finally {
          if (outside) await within(outside, 'outside reader cleanup')
        }
      },
    }),
  ),
]
