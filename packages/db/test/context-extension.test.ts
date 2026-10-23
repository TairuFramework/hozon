import type { Adapter } from '@hozon/adapter'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import {
  type BaseStoreContext,
  type ContextFactory,
  HozonDB,
  type StoreContext,
  type StoreDefinition,
  type StoreProvider,
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

test('released savepoint APIs forward later commit hooks to the outer transaction', async () => {
  const db = new ExtendedDB()
  const events: Array<string> = []
  try {
    await db.withTransaction<Stores, void>(async (tx) => {
      if (tx.withSavepoint == null) throw new Error('Missing savepoints')
      const api = await tx.withSavepoint<Stores, Api>((sp) => sp.getStore('context'))
      api.provider.onCommit(() => events.push('committed'))
      expect(events).toEqual([])
    })
    expect(events).toEqual(['committed'])
  } finally {
    await db.close()
  }
})

test('released savepoint APIs forward later rollback hooks to the outer transaction', async () => {
  const db = new ExtendedDB()
  const events: Array<string> = []
  const error = new Error('outer rollback')
  try {
    await expect(
      db.withTransaction<Stores, void>(async (tx) => {
        if (tx.withSavepoint == null) throw new Error('Missing savepoints')
        const api = await tx.withSavepoint<Stores, Api>((sp) => sp.getStore('context'))
        api.provider.onRollback(() => events.push('rolled back'))
        expect(events).toEqual([])
        throw error
      }),
    ).rejects.toBe(error)
    expect(events).toEqual(['rolled back'])
  } finally {
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
