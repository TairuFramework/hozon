import type { Adapter } from '@hozon/adapter'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import {
  type BaseStoreContext,
  type ContextFactory,
  HozonDB,
  SavepointReleasedError,
  type StoreContext,
  type StoreDefinition,
  type StoreProvider,
  withKeyLock,
  withKeyLocks,
} from '../src/index.js'

type Extension = { value: string }
type Api = StoreContext<Extension>
type Stores = { context: Api }
const definition: StoreDefinition<Record<string, never>, Api, Extension> = {
  name: 'context',
  migrations: {},
  createAPI: (_db, _adapter, context) => context,
}

class ExtendedDB extends HozonDB<Extension> {
  #value = 'initial'

  constructor() {
    super({
      adapter: new NodeSQLiteAdapter({ database: ':memory:' }),
      context: (scope) => this.#createContext(scope),
    })
    this.register(definition)
  }

  setValue(value: string): void {
    this.#value = value
  }

  #createContext(_scope: Parameters<ContextFactory<Extension>>[0]): Extension {
    const read = () => this.#value
    return {
      get value() {
        return read()
      },
    }
  }
}

test('context extension keeps accessors live', async () => {
  const db = new ExtendedDB()
  try {
    const api = await db.getStore<Api>('context')
    expect(api.value).toBe('initial')
    db.setValue('updated')
    expect(await db.getStore('context')).toBe(api)
    expect(api.value).toBe('updated')
  } finally {
    await db.close()
  }
})

test('context receives the scope provider', async () => {
  const received: Array<{ provider: StoreProvider; root: StoreProvider }> = []
  const db = new HozonDB<Extension>({
    adapter: new NodeSQLiteAdapter({ database: ':memory:' }),
    context: (scope) => {
      received.push(scope)
      return { value: 'scoped' }
    },
  })
  db.register({
    name: 'binding',
    migrations: {},
    createAPI: (db, _adapter, context) => ({ context, isTransaction: db.isTransaction }),
  })
  type Binding = { context: Api; isTransaction: boolean }
  try {
    await db.withTransaction<{ binding: Binding }, void>(async (tx) => {
      const api = await tx.getStore('binding')
      expect(api.isTransaction).toBe(true)
      expect(api.context.provider).toBe(tx)
      expect(api.context.root).toBe(db)
      expect(api.context.provider.isTransactionBound).toBe(true)
      expect(api.context.root.isTransactionBound).toBe(false)
      expect(received).toEqual([{ provider: tx, root: db }])
    })
  } finally {
    await db.close()
  }
})

test('store API caches are per provider scope', async () => {
  const db = new ExtendedDB()
  const committed: Array<string> = []
  try {
    const root = await db.getStore<Api>('context')
    let previous: Api | undefined
    for (let index = 0; index < 2; index++) {
      await db.withScope<Stores, void>(async (scope) => {
        const api = await scope.getStore('context')
        expect(api).not.toBe(root)
        expect(api).not.toBe(previous)
        expect(api.provider).toBe(scope)
        expect(await scope.getStore('context')).toBe(api)
        previous = api
      })
    }
    await db.withTransaction<Stores, void>(async (tx) => {
      const outer = await tx.getStore('context')
      expect(outer).not.toBe(root)
      outer.provider.onCommit(() => committed.push('outer'))
      if (tx.withSavepoint == null) throw new Error('Missing savepoints')
      await expect(
        tx.withSavepoint<Stores, void>(async (sp) => {
          const inner = await sp.getStore('context')
          expect(inner).not.toBe(outer)
          expect(inner.provider).toBe(sp)
          expect(await sp.getStore('context')).toBe(inner)
          inner.provider.onCommit(() => committed.push('discarded'))
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      await tx.withSavepoint<Stores, void>(async (sp) => {
        const inner = await sp.getStore('context')
        inner.provider.onCommit(() => committed.push('released'))
      })
      expect(await tx.getStore('context')).toBe(outer)
      expect(committed).toEqual([])
    })
    expect(committed).toEqual(['outer', 'released'])
  } finally {
    await db.close()
  }
})

test('stores without context get the base context', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  db.register({ name: 'base', migrations: {}, createAPI: (_db, _adapter, context) => context })
  try {
    const context = await db.getStore<BaseStoreContext>('base')
    expect(context.provider).toBe(db)
    expect(context.root).toBe(db)
    let closed = false
    context.onClose(() => {
      closed = true
    })
    const loader = context.createLoader<string, string>({
      maxBatchSize: 500,
      load: async (keys) => new Map(keys.map((key) => [key, `value:${key}`])),
    })
    expect(await loader.load('key')).toBe('value:key')
    await db.close()
    expect(closed).toBe(true)
  } finally {
    await db.close()
  }
})

const settledOperations: Record<string, (provider: StoreProvider) => unknown> = {
  getStore: (provider) => provider.getStore('context'),
  hasStore: (provider) => provider.hasStore('context'),
  onCommit: (provider) => provider.onCommit(() => {}),
  onRollback: (provider) => provider.onRollback(() => {}),
  withSavepoint: (provider) => provider.withSavepoint?.(async () => {}),
  withTransaction: (provider) => provider.withTransaction(async () => {}),
  withScope: (provider) => provider.withScope?.(async () => {}),
  withKeyLock: (provider) => withKeyLock(provider, 'items', ['a'], async () => {}),
  withKeyLocks: (provider) => withKeyLocks(provider, 'items', [], async () => {}),
}

for (const rollback of [false, true]) {
  for (const [method, operation] of Object.entries(settledOperations)) {
    test(`settled savepoint rejects ${method} (rollback: ${rollback})`, async () => {
      const db = new ExtendedDB()
      try {
        await db.withTransaction(async (tx) => {
          if (!tx.withSavepoint) throw new Error('Missing savepoints')
          let retained: StoreProvider | undefined
          let locked: StoreProvider | undefined
          const attempt = tx.withSavepoint(async (sp) => {
            retained = sp
            await withKeyLocks(sp, 'items', [], async (provider) => {
              locked = provider
            })
            if (rollback) throw new Error('rollback')
          })
          if (rollback) await expect(attempt).rejects.toThrow('rollback')
          else await attempt
          if (!retained || !locked) throw new Error('Missing retained providers')
          for (const provider of [retained, locked]) {
            await expect(Promise.resolve().then(() => operation(provider))).rejects.toBeInstanceOf(
              SavepointReleasedError,
            )
          }
        })
      } finally {
        await db.close()
      }
    })
  }
}

test.each([false, true])(
  'settled savepoint APIs and bound context methods reject further use (rollback: %s)',
  async (rollback) => {
    const db = new ExtendedDB()
    db.register({
      name: 'methods',
      migrations: {},
      createAPI: (query, _adapter, context) => ({
        constant: () => 'value',
        query: () => query.selectNoFrom((eb) => eb.val(1).as('value')).execute(),
        context,
      }),
    })
    type Methods = { constant(): string; query(): Promise<unknown>; context: Api }
    try {
      await db.withTransaction(async (tx) => {
        if (!tx.withSavepoint) throw new Error('Missing savepoints')
        let api: Methods | undefined
        let constant: (() => string) | undefined
        const attempt = tx.withSavepoint<{ methods: Methods }, void>(async (sp) => {
          api = await sp.getStore('methods')
          constant = api.constant
          expect(constant()).toBe('value')
          if (rollback) throw new Error('rollback')
        })
        if (rollback) await expect(attempt).rejects.toThrow('rollback')
        else await attempt
        if (!api || !constant) throw new Error('Missing retained API')
        const retained = api
        for (const operation of [
          constant,
          () => retained.constant(),
          () => retained.query(),
          () => retained.context.compareWrite('missing', {}),
          () => retained.context.createLoader({ maxBatchSize: 1, load: async () => new Map() }),
        ]) {
          await expect(Promise.resolve().then(operation)).rejects.toBeInstanceOf(
            SavepointReleasedError,
          )
        }
        let closed = false
        api.context.onClose(() => {
          closed = true
        })
        expect(closed).toBe(false)
      })
    } finally {
      await db.close()
    }
  },
)

test('released provider rejects the nested key-lock deadlock sequence at first use', async () => {
  const db = new ExtendedDB()
  db.register({
    name: 'locks',
    migrations: {
      '0-init': {
        async up(query) {
          await query.schema.createTable('items').addColumn('id', 'text').execute()
        },
      },
    },
    createAPI: () => ({}),
  })
  let entered = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await db.withTransaction(async (tx) => {
      if (!tx.withSavepoint) throw new Error('Missing savepoints')
      const retained = await tx.withSavepoint(async (sp) => sp)
      const attempt = withKeyLock(retained, 'items', ['a'], async (locked) => {
        entered = true
        if (!locked.withSavepoint) throw new Error('Missing savepoints')
        await locked.withSavepoint(async (child) => {
          await withKeyLock(child, 'items', ['a'], async () => {})
        })
      })
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('key-lock sequence timed out')), 500)
      })
      await expect(Promise.race([attempt, deadline])).rejects.toBeInstanceOf(SavepointReleasedError)
      expect(entered).toBe(false)
    })
  } finally {
    clearTimeout(timeout)
    await db.close()
  }
})

// Compiled by test:types, without constructing unclosed databases at runtime.
function checkContextTypes(adapter: Adapter, provider: StoreProvider) {
  new HozonDB({ adapter })
  new HozonDB<Extension>({ adapter, context: () => ({ value: 'valid' }) })
  // @ts-expect-error Non-empty extensions require a context factory.
  new HozonDB<Extension>({ adapter })
  new HozonDB({ adapter, context: () => ({ value: 'valid' }) })
  // @ts-expect-error Reserved keys are forbidden even when their value is undefined.
  new HozonDB({ adapter, context: () => ({ value: 'invalid', provider: undefined }) })
  // @ts-expect-error Factories cannot replace the base provider.
  new HozonDB({ adapter, context: () => ({ value: 'invalid', provider }) })
  // @ts-expect-error Extensions cannot declare base keys.
  new HozonDB<{ provider: StoreProvider }>({
    adapter,
    context: () => ({ provider }),
  })
  const db = new HozonDB<Extension>({ adapter, context: () => ({ value: 'valid' }) })
  db.register(definition)
  const base: StoreDefinition<Record<string, never>, BaseStoreContext> = {
    name: 'base',
    migrations: {},
    createAPI: (_db, _adapter, context) => context,
  }
  db.register(base)
  const unavailable: StoreDefinition<Record<string, never>, number, { missing: number }> = {
    name: 'unavailable',
    migrations: {},
    createAPI: (_db, _adapter, context) => context.missing,
  }
  // @ts-expect-error Registration requires the extension consumed by the store.
  db.register(unavailable)
}
void checkContextTypes
