import type { Adapter, ColumnTypes, Functions } from '@hozon/adapter'
import { getLogger, type Logger } from '@sozai/log'
import { Kysely, sql } from 'kysely'
import { type Migration, Migrator } from 'kysely/migration'

import type { BatchLoader, BatchLoaderParams } from './batch-loader.js'
import { withTransactionalDDL } from './dialect.js'
import {
  HozonDBClosedError,
  InvalidTablePrefixError,
  SavepointOverlapError,
  SavepointReleasedError,
} from './errors.js'
import { LoaderRegistry } from './loader-registry.js'
import { checkStore, readAppliedMigrations } from './preflight.js'
import {
  bindSyncProvider,
  type CompareDefinition,
  compareWrite,
  settleSyncProvider,
} from './sync.js'
import { TablePrefixPlugin } from './table-prefix.js'

export type MigrationContext = {
  tablePrefix: string
  kind: Adapter['kind']
  types: ColumnTypes
  functions: Functions
}

export type BaseStoreContext = {
  compareWrite<T extends string>(
    table: T,
    row: Record<string, unknown>,
  ): Promise<{ changed: boolean }>
  createLoader<TKey, TValue>(params: BatchLoaderParams<TKey, TValue>): BatchLoader<TKey, TValue>
  provider: StoreProvider
  root: StoreProvider
  onClose(fn: () => Promise<void> | void): void
}

type ContextExtension = object & { [Key in keyof BaseStoreContext]?: never }

// biome-ignore lint/complexity/noBannedTypes: The default adds no context fields.
export type StoreContext<Ext extends ContextExtension = {}> = BaseStoreContext & Ext

export type ContextFactory<Ext extends ContextExtension> = (scope: {
  provider: StoreProvider
  root: StoreProvider
}) => keyof Ext & keyof BaseStoreContext extends never ? Ext : never

// biome-ignore lint/complexity/noBannedTypes: The default adds no context fields.
export type StoreDefinition<Tables, API, Ext extends ContextExtension = {}> = {
  name: string
  migrations: Record<string, Migration> | ((ctx: MigrationContext) => Record<string, Migration>)
  dependsOn?: Array<string>
  /**
   * Logical table names this store keeps outside the table prefix, for example
   * dynamic tables whose names would exceed identifier length limits. Matching
   * tables are not namespaced: the store must keep them collision-free.
   */
  unprefixedTables?: (name: string) => boolean
  sync?: { [T in keyof Tables & string]?: CompareDefinition<Tables[T]> }
  createAPI: (db: Kysely<Tables>, adapter: Adapter, context: StoreContext<Ext>) => API
}

export type StoreProvider<Stores extends Record<string, unknown> = Record<string, unknown>> = {
  readonly isTransactionBound: boolean
  /** Identity of the outermost transaction provider, shared by savepoints. Absent outside transactions. */
  readonly transactionRoot?: StoreProvider
  getStore<S extends keyof Stores & string>(name: S): Promise<Stores[S]>
  /**
   * Returns whether a store definition is registered, synchronously and
   * WITHOUT triggering migration. This distinguishes "plugin not installed"
   * (registration absent) from "plugin installed but its store currently
   * errors" — callers can fail closed on the latter instead of mistaking a
   * transient store error for an uninstalled plugin.
   */
  hasStore(name: string): boolean
  onCommit(fn: () => void): void
  /**
   * Register a hook to run after the transaction rolls back. By the time the
   * hook fires the DB is already reverted, so it is the correct place to drop
   * any in-memory state that was eagerly advanced in anticipation of a commit
   * (e.g. cache invalidation). Like `onCommit`, hooks are isolated and their
   * errors logged, never re-thrown. On the non-transactional provider it is a
   * no-op (each standalone op auto-commits; nothing to roll back).
   */
  onRollback(fn: () => void): void
  /**
   * Run `fn` against a `StoreProvider` that scopes its writes to a transaction.
   *
   * On `HozonDB`, opens a fresh DB transaction and provides a transactional
   * `tx` provider; the outer provider's `onCommit` hooks fire after commit.
   *
   * On a transactional `tx` provider obtained from a parent
   * `withTransaction` call, this method runs `fn` inline with `this` as the
   * nested `tx`. The underlying driver does not nest transactions
   * (no implicit savepoints), so atomicity is inherited from the enclosing
   * transaction or explicit savepoint.
   */
  withTransaction<NestedStores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
  withScope?<NestedStores extends Record<string, unknown>, R>(
    fn: (scope: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
  /** Roll back only this unit of work when called inside a transaction. */
  withSavepoint?<NestedStores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
}

// biome-ignore lint/complexity/noBannedTypes: The default adds no context fields.
export type HozonDBParams<Ext extends ContextExtension = {}> = {
  adapter: Adapter
  logger?: Logger
  tablePrefix?: string
} & (keyof Ext extends never ? { context?: ContextFactory<Ext> } : { context: ContextFactory<Ext> })

type StoredDefinition<Ext extends ContextExtension> = {
  name: string
  migrations: Record<string, Migration> | ((ctx: MigrationContext) => Record<string, Migration>)
  dependsOn?: Array<string>
  unprefixedTables?: (name: string) => boolean
  sync?: Record<string, CompareDefinition<Record<string, unknown>>>
  createAPI: (
    db: Kysely<Record<string, unknown>>,
    adapter: Adapter,
    context: StoreContext<Ext>,
  ) => unknown
}

// biome-ignore lint/complexity/noBannedTypes: The default adds no context fields.
export class HozonDB<Ext extends ContextExtension = {}> implements StoreProvider {
  #context?: ContextFactory<Ext>
  #closeHooks: Array<() => Promise<void> | void> = []
  #tablePrefix: string
  #defaultPlugin: TablePrefixPlugin
  #closed = false
  #closing: Promise<void> | null = null
  #preflight: Promise<void> | null = null
  #checked = new Set<string>()
  #migrations = new Map<string, Record<string, Migration>>()
  #adapter: Adapter
  #db: Kysely<Record<string, unknown>>
  #storeDB: Kysely<Record<string, unknown>>
  #storePlugins = new Map<string, TablePrefixPlugin>()
  #logger: Logger
  #migrated: Map<string, Promise<void>> = new Map()
  #loaders = new LoaderRegistry({ remember: false })
  #storeAPIs: Map<string, unknown> = new Map()
  #stores: Map<string, StoredDefinition<Ext>> = new Map()

  constructor(params: HozonDBParams<Ext>) {
    this.#context = params.context
    this.#tablePrefix = params.tablePrefix ?? 'hozon'
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(this.#tablePrefix)) {
      throw new InvalidTablePrefixError(this.#tablePrefix)
    }
    this.#defaultPlugin = new TablePrefixPlugin(this.#tablePrefix)
    this.#adapter = params.adapter
    this.#db = new Kysely<Record<string, unknown>>({
      // SQLite supports transactional DDL, but Kysely's SQLite adapters do not report it.
      dialect:
        this.#adapter.kind === 'sqlite'
          ? withTransactionalDDL(this.#adapter.dialect)
          : this.#adapter.dialect,
    })
    this.#storeDB = this.#db.withPlugin(this.#defaultPlugin)
    this.#logger = params.logger ?? getLogger(['hozon', 'db'])
  }

  get adapter(): Adapter {
    return this.#adapter
  }

  get isTransactionBound(): boolean {
    return false
  }

  get transactionRoot(): StoreProvider | undefined {
    return undefined
  }

  register<Tables, API>(store: StoreDefinition<Tables, API, Ext>): void {
    const existing = this.#stores.get(store.name)
    if (existing != null) {
      if (existing !== (store as unknown as StoredDefinition<Ext>)) {
        this.#logger.warn('store "{name}" registered with different definition, ignoring', {
          name: store.name,
        })
      }
      return
    }
    this.#stores.set(store.name, store as unknown as StoredDefinition<Ext>)
  }

  async getStore<T>(name: string): Promise<T> {
    this.#assertOpen()
    await this.#ensurePreflight()
    await this.#ensureMigrated(name)
    this.#assertOpen()
    if (!this.#storeAPIs.has(name)) {
      const store = this.#stores.get(name)
      if (store == null) {
        throw new Error(`Store "${name}" is not registered`)
      }
      this.#storeAPIs.set(
        name,
        this.#createStoreAPI(store, this.#db, this.#storeDB, this.#loaders, this),
      )
    }
    return this.#storeAPIs.get(name) as T
  }

  hasStore(name: string): boolean {
    return this.#stores.has(name)
  }

  onCommit(fn: () => void): void {
    fn()
  }

  // Each standalone op auto-commits, so there is nothing to roll back — no-op.
  onRollback(_fn: () => void): void {}

  async withScope<Stores extends Record<string, unknown>, R>(
    fn: (scope: StoreProvider<Stores>) => Promise<R>,
  ): Promise<R> {
    this.#assertOpen()
    const registry = new LoaderRegistry({ remember: true })
    const storeAPIs = new Map<string, unknown>()
    const provider: StoreProvider<Stores> = {
      isTransactionBound: false,
      getStore: async <S extends keyof Stores & string>(name: S): Promise<Stores[S]> => {
        this.#assertOpen()
        await this.#ensurePreflight()
        await this.#ensureMigrated(name)
        this.#assertOpen()
        if (!storeAPIs.has(name)) {
          const store = this.#stores.get(name)
          if (store == null) throw new Error(`Store "${name}" is not registered`)
          storeAPIs.set(
            name,
            this.#createStoreAPI(store, this.#db, this.#storeDB, registry, provider),
          )
        }
        return storeAPIs.get(name) as Stores[S]
      },
      hasStore: (name) => this.hasStore(name),
      onCommit: (hook) => hook(),
      onRollback: () => {},
      withScope: async <NestedStores extends Record<string, unknown>, R>(
        nestedFn: (scope: StoreProvider<NestedStores>) => Promise<R>,
      ): Promise<R> => {
        return await nestedFn(provider as unknown as StoreProvider<NestedStores>)
      },
      withTransaction: async (nestedFn) => {
        return await this.#withTransaction(nestedFn, () => registry.clearAll())
      },
    }
    try {
      return await fn(provider)
    } finally {
      registry.close()
    }
  }

  /**
   * Runs `fn` inside a DB transaction and provides a scoped `StoreProvider`.
   * Concurrent calls on the same `HozonDB` instance are supported — the
   * underlying driver serializes them.
   *
   * Callers MUST use the provided `tx` inside the callback. Calling
   * `db.withTransaction` on the same instance inside the callback opens a
   * new independent transaction (no atomic nesting) and is a bug.
   */
  async withTransaction<Stores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<Stores>) => Promise<R>,
  ): Promise<R> {
    return await this.#withTransaction(fn)
  }

  async #withTransaction<Stores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<Stores>) => Promise<R>,
    beforeHooks?: () => void,
  ): Promise<R> {
    // Migrate every registered store before opening the transaction. Stores
    // are internal and known up front, so a broken migration should fail fast
    // at startup rather than leave a runtime partition where one store's
    // failure silently blocks transactions that never touch it.
    await this.migrate()
    this.#assertOpen()

    const commitHooks: Array<() => void> = []
    const rollbackHooks: Array<() => void> = []

    const registry = new LoaderRegistry({ remember: true })
    let result: R
    let savepointID = 0
    try {
      // The transaction runs on the unprefixed base so each store applies its own plugin.
      result = await this.#db.transaction().execute(async (trx) => {
        const txKysely = trx as unknown as Kysely<Record<string, unknown>>
        const txStoreDB = txKysely.withPlugin(this.#defaultPlugin)

        const createScopedProvider = (
          scopedCommitHooks: Array<() => void>,
          scopedRollbackHooks: Array<() => void>,
          transactionRoot?: StoreProvider,
          syncParent?: StoreProvider,
          syncSavepoint = false,
          scopeState = { savepointOpen: false, settled: false, savepointBound: syncSavepoint },
        ): StoreProvider<Stores> => {
          // Savepoints on one connection form a stack: a scope holds at most
          // one open savepoint, and nesting goes through that savepoint's
          // own provider.
          const assertActive = () => {
            if (scopeState.settled) throw new SavepointReleasedError()
          }
          const txStoreAPIs = new Map<string, unknown>()
          const provider: StoreProvider<Stores> = {
            isTransactionBound: true,
            get transactionRoot() {
              return transactionRoot ?? provider
            },
            getStore: async <S extends keyof Stores & string>(name: S): Promise<Stores[S]> => {
              assertActive()
              this.#assertOpen()
              if (!txStoreAPIs.has(name)) {
                const store = this.#stores.get(name)
                if (store == null) {
                  throw new Error(`Store "${name}" is not registered`)
                }
                txStoreAPIs.set(
                  name,
                  this.#createStoreAPI(
                    store,
                    txKysely,
                    txStoreDB,
                    registry,
                    provider,
                    scopeState.savepointBound ? assertActive : undefined,
                  ),
                )
              }
              return txStoreAPIs.get(name) as Stores[S]
            },
            hasStore: (name: string): boolean => {
              assertActive()
              return this.#stores.has(name)
            },
            onCommit: (hook: () => void) => {
              assertActive()
              scopedCommitHooks.push(hook)
            },
            onRollback: (hook: () => void) => {
              assertActive()
              scopedRollbackHooks.push(hook)
            },
            withScope: async <NestedStores extends Record<string, unknown>, R>(
              nestedFn: (scope: StoreProvider<NestedStores>) => Promise<R>,
            ): Promise<R> => {
              assertActive()
              return await nestedFn(provider as unknown as StoreProvider<NestedStores>)
            },
            withTransaction: async <NestedStores extends Record<string, unknown>, R>(
              nestedFn: (tx: StoreProvider<NestedStores>) => Promise<R>,
            ): Promise<R> => {
              // Already inside a transaction — Kysely does not nest.
              // Run `nestedFn` inline with the same provider so its hooks and
              // writes remain within the enclosing transaction or savepoint.
              assertActive()
              return await nestedFn(provider as unknown as StoreProvider<NestedStores>)
            },
            withSavepoint: async <NestedStores extends Record<string, unknown>, R>(
              nestedFn: (tx: StoreProvider<NestedStores>) => Promise<R>,
            ): Promise<R> => {
              assertActive()
              if (scopeState.savepointOpen) throw new SavepointOverlapError()
              scopeState.savepointOpen = true
              try {
                const name = `${this.#tablePrefix}_sp_${++savepointID}`
                const savepointCommitHooks: Array<() => void> = []
                const savepointRollbackHooks: Array<() => void> = []
                const savepointState = {
                  savepointOpen: false,
                  settled: false,
                  savepointBound: true,
                }
                const scopedProvider = createScopedProvider(
                  savepointCommitHooks,
                  savepointRollbackHooks,
                  provider.transactionRoot,
                  provider,
                  true,
                  savepointState,
                )
                registry.dispatchAll()
                await sql.raw(`SAVEPOINT ${name}`).execute(trx)
                try {
                  const value = await nestedFn(
                    scopedProvider as unknown as StoreProvider<NestedStores>,
                  )
                  registry.dispatchAll()
                  await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(trx)
                  savepointState.settled = true
                  registry.clearAll()
                  for (const hook of savepointCommitHooks) provider.onCommit(hook)
                  for (const hook of savepointRollbackHooks) provider.onRollback(hook)
                  return value
                } catch (error) {
                  registry.dispatchAll()
                  await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(trx)
                  registry.dispatchAll()
                  await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(trx)
                  savepointState.settled = true
                  registry.clearAll()
                  this.#runHooks(savepointRollbackHooks, 'rollback')
                  throw error
                } finally {
                  savepointState.settled = true
                  settleSyncProvider(scopedProvider)
                }
              } finally {
                scopeState.savepointOpen = false
              }
            },
          }
          bindSyncProvider(
            provider,
            {
              assertActive,
              derive: () =>
                createScopedProvider(
                  scopedCommitHooks,
                  scopedRollbackHooks,
                  provider.transactionRoot,
                  provider,
                  false,
                  scopeState,
                ),
              db: txKysely,
              kind: this.#adapter.kind,
              tablePrefix: this.#tablePrefix,
              tableName: (table) => {
                const unprefixed = [...this.#stores.values()].some((store) =>
                  store.unprefixedTables?.(table),
                )
                return unprefixed ? table : `${this.#tablePrefix}_${table}`
              },
            },
            syncParent,
            syncSavepoint,
          )
          return provider
        }

        try {
          return await fn(createScopedProvider(commitHooks, rollbackHooks))
        } finally {
          registry.dispatchAll()
        }
      })
    } catch (err) {
      registry.close()
      // Kysely issues ROLLBACK and rejects `execute()` when the callback
      // throws, so the DB is already reverted here. Run the rollback hooks to
      // drop any in-memory state that was eagerly advanced expecting a commit
      // (revert first, then drop the stale cache). Hooks are isolated/logged,
      // never re-thrown; the original error is preserved so callers (e.g. the
      // engine's `MutateGraphWriteRollback` sentinel) still observe it.
      this.#runHooks(rollbackHooks, 'rollback')
      throw err
    }

    registry.close()
    beforeHooks?.()
    // The transaction has committed; post-commit hooks are best-effort side
    // effects (event emission, cache invalidation). A throwing hook must not
    // skip the remaining hooks or make the caller observe a durable write as a
    // failure, so each hook is isolated and its error logged, never re-thrown.
    this.#runHooks(commitHooks, 'commit')
    return result
  }

  #runHooks(hooks: Array<() => void>, phase: 'commit' | 'rollback'): void {
    for (const [index, hook] of hooks.entries()) {
      try {
        hook()
      } catch (error) {
        this.#logger.error(`${phase} hook {index}/{count} failed`, {
          index,
          count: hooks.length,
          error,
        })
      }
    }
  }

  async migrate(): Promise<void> {
    this.#assertOpen()
    await this.#ensurePreflight()
    await Promise.all(Array.from(this.#stores.keys()).map((name) => this.#ensureMigrated(name)))
  }

  close(): Promise<void> {
    this.#closed = true
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    // Publish #closing before a hook can re-enter close().
    await Promise.resolve()
    for (const hook of this.#closeHooks) {
      try {
        await hook()
      } catch (error) {
        this.#logger.error('close hook failed', { error })
      }
    }
    try {
      await this.#db.destroy()
    } finally {
      await this.#adapter.close?.()
    }
    this.#logger.info('closed')
  }

  #assertOpen(): void {
    if (this.#closed) throw new HozonDBClosedError()
  }

  #getMigrations(store: StoredDefinition<Ext>): Record<string, Migration> {
    let migrations = this.#migrations.get(store.name)
    if (migrations == null) {
      const storeMigrations =
        typeof store.migrations === 'function'
          ? store.migrations({
              tablePrefix: this.#tablePrefix,
              kind: this.#adapter.kind,
              types: this.#adapter.types,
              functions: this.#adapter.functions,
            })
          : store.migrations
      const plugin = this.#getStorePlugin(store)
      migrations = Object.fromEntries(
        Object.entries(storeMigrations).map(([name, migration]) => {
          const down = migration.down
          return [
            name,
            {
              up: (db) => migration.up(db.withPlugin(plugin)),
              down: down && ((db) => down.call(migration, db.withPlugin(plugin))),
            } satisfies Migration,
          ]
        }),
      )
      this.#migrations.set(store.name, migrations)
    }
    return migrations
  }

  // Stores on the default plugin must share one Kysely instance: keep-set locks key on it.
  #createStoreAPI(
    store: StoredDefinition<Ext>,
    kysely: Kysely<Record<string, unknown>>,
    defaultDB: Kysely<Record<string, unknown>>,
    registry: LoaderRegistry,
    provider: StoreProvider,
    assertActive?: () => void,
  ): unknown {
    const storeDB =
      store.unprefixedTables == null ? defaultDB : kysely.withPlugin(this.#getStorePlugin(store))
    const base: BaseStoreContext = {
      compareWrite: async (table, row) => {
        assertActive?.()
        return await compareWrite(storeDB, table, row, store.sync?.[table])
      },
      createLoader: (params) => {
        assertActive?.()
        return registry.createLoader(params)
      },
      provider,
      root: this,
      onClose: (fn) => {
        this.#assertOpen()
        this.#closeHooks.push(fn)
      },
    }
    const ext = this.#context?.({ provider, root: this })
    const context = Object.defineProperties(
      base,
      Object.getOwnPropertyDescriptors(ext ?? {}),
    ) as StoreContext<Ext>
    return store.createAPI(storeDB, this.#adapter, context)
  }

  #getStorePlugin(store: StoredDefinition<Ext>): TablePrefixPlugin {
    if (store.unprefixedTables == null) return this.#defaultPlugin
    let plugin = this.#storePlugins.get(store.name)
    if (plugin == null) {
      plugin = new TablePrefixPlugin(this.#tablePrefix, { unprefixed: store.unprefixedTables })
      this.#storePlugins.set(store.name, plugin)
    }
    return plugin
  }

  #ensurePreflight(): Promise<void> {
    // Snapshot before awaiting so concurrent triggers share one read-only gate.
    // A failed attempt clears the gate so the next caller reruns the read-only checks,
    // then preparation; a successful attempt stays cached.
    if (this.#preflight == null) {
      const attempt: Promise<void> = this.#runPreflight(Array.from(this.#stores.values())).catch(
        (err) => {
          if (this.#preflight === attempt) this.#preflight = null
          throw err
        },
      )
      this.#preflight = attempt
    }
    return this.#preflight
  }

  async #runPreflight(stores: Array<StoredDefinition<Ext>>): Promise<void> {
    for (const store of stores) {
      await checkStore(
        this.#db,
        this.#tablePrefix,
        store.name,
        Object.keys(this.#getMigrations(store)),
      )
      this.#checked.add(store.name)
    }
    this.#assertOpen()
    await this.#adapter.prepare?.()
  }

  async #ensureMigrated(name: string): Promise<void> {
    let pending = this.#migrated.get(name)
    if (pending == null) {
      pending = this.#runStoreMigrations(name).catch((err) => {
        this.#migrated.delete(name)
        throw err
      })
      this.#migrated.set(name, pending)
    }
    return pending
  }

  async #runStoreMigrations(name: string): Promise<void> {
    const store = this.#stores.get(name)
    if (store == null) {
      throw new Error(`Store "${name}" is not registered`)
    }
    this.#assertOpen()
    const migrations = this.#getMigrations(store)
    if (!this.#checked.has(name)) {
      await checkStore(this.#db, this.#tablePrefix, name, Object.keys(migrations))
      this.#checked.add(name)
    }
    for (const dep of store.dependsOn ?? []) {
      await this.#ensureMigrated(dep)
    }
    this.#assertOpen()

    if (Object.keys(migrations).length === 0) {
      return
    }

    // Kysely's migrator opens a transaction even when nothing is pending, which fails while
    // another database instance holds the same single SQLite connection in a transaction.
    const applied = await readAppliedMigrations(this.#db, this.#tablePrefix, name)
    if (applied != null && Object.keys(migrations).every((key) => applied.has(key))) {
      this.#logger.debug('store {name} migrations already applied', { name })
      return
    }

    const migrator = new Migrator({
      db: this.#db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
      migrationTableName: `${this.#tablePrefix}_${name}_migration`,
      migrationLockTableName: `${this.#tablePrefix}_${name}_migration_lock`,
    })
    const result = await migrator.migrateToLatest()
    if (result.error != null) {
      throw result.error
    }
    this.#logger.info('store {name} migrations complete', { name })
  }
}
