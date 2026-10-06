import type { Adapter, ColumnTypes, Functions } from '@hozon/adapter'
import { getLogger, type Logger } from '@sozai/log'
import { Kysely, ParseJSONResultsPlugin, sql } from 'kysely'
import { type Migration, Migrator } from 'kysely/migration'

import { withTransactionalDDL } from './dialect.js'
import { HozonDBClosedError, InvalidTablePrefixError, SavepointOverlapError } from './errors.js'
import { checkStore } from './preflight.js'

export type MigrationContext = {
  kind: Adapter['kind']
  types: ColumnTypes
  functions: Functions
}

export type StoreDefinition<Tables, API> = {
  name: string
  migrations: Record<string, Migration> | ((ctx: MigrationContext) => Record<string, Migration>)
  dependsOn?: Array<string>
  createAPI: (db: Kysely<Tables>, adapter: Adapter) => API
}

export type StoreProvider<Stores extends Record<string, unknown> = Record<string, unknown>> = {
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
  /** Roll back only this unit of work when called inside a transaction. */
  withSavepoint?<NestedStores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
}

export type HozonDBParams = {
  adapter: Adapter
  logger?: Logger
  tablePrefix?: string
}

type StoredDefinition = {
  name: string
  migrations: Record<string, Migration> | ((ctx: MigrationContext) => Record<string, Migration>)
  dependsOn?: Array<string>
  createAPI: (db: Kysely<Record<string, unknown>>, adapter: Adapter) => unknown
}

export class HozonDB implements StoreProvider {
  #tablePrefix: string
  #closed = false
  #closing: Promise<void> | null = null
  #preflight: Promise<void> | null = null
  #checked = new Set<string>()
  #migrations = new Map<string, Record<string, Migration>>()
  #adapter: Adapter
  #db: Kysely<Record<string, unknown>>
  #logger: Logger
  #migrated: Map<string, Promise<void>> = new Map()
  #storeAPIs: Map<string, unknown> = new Map()
  #stores: Map<string, StoredDefinition> = new Map()

  constructor(params: HozonDBParams) {
    this.#tablePrefix = params.tablePrefix ?? 'hozon'
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(this.#tablePrefix)) {
      throw new InvalidTablePrefixError(this.#tablePrefix)
    }
    this.#adapter = params.adapter
    this.#db = new Kysely<Record<string, unknown>>({
      // SQLite supports transactional DDL, but Kysely's SQLite adapters do not report it.
      dialect:
        this.#adapter.kind === 'sqlite'
          ? withTransactionalDDL(this.#adapter.dialect)
          : this.#adapter.dialect,
      plugins: [new ParseJSONResultsPlugin()],
    })
    this.#logger = params.logger ?? getLogger(['hozon', 'db'])
  }

  get adapter(): Adapter {
    return this.#adapter
  }

  register<Tables, API>(store: StoreDefinition<Tables, API>): void {
    const existing = this.#stores.get(store.name)
    if (existing != null) {
      if (existing !== (store as unknown as StoredDefinition)) {
        this.#logger.warn('store "{name}" registered with different definition, ignoring', {
          name: store.name,
        })
      }
      return
    }
    this.#stores.set(store.name, store as unknown as StoredDefinition)
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
      this.#storeAPIs.set(name, store.createAPI(this.#db, this.#adapter))
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
    // Migrate every registered store before opening the transaction. Stores
    // are internal and known up front, so a broken migration should fail fast
    // at startup rather than leave a runtime partition where one store's
    // failure silently blocks transactions that never touch it.
    await this.migrate()
    this.#assertOpen()

    const commitHooks: Array<() => void> = []
    const rollbackHooks: Array<() => void> = []

    let result: R
    let savepointID = 0
    try {
      result = await this.#db.transaction().execute(async (trx) => {
        const txKysely = trx as unknown as Kysely<Record<string, unknown>>
        const txStoreAPIs = new Map<string, unknown>()

        const createScopedProvider = (
          scopedCommitHooks: Array<() => void>,
          scopedRollbackHooks: Array<() => void>,
        ): StoreProvider<Stores> => {
          // Savepoints on one connection form a stack: a scope holds at most
          // one open savepoint, and nesting goes through that savepoint's
          // own provider.
          let savepointOpen = false
          const provider: StoreProvider<Stores> = {
            getStore: async <S extends keyof Stores & string>(name: S): Promise<Stores[S]> => {
              if (!txStoreAPIs.has(name)) {
                const store = this.#stores.get(name)
                if (store == null) {
                  throw new Error(`Store "${name}" is not registered`)
                }
                txStoreAPIs.set(name, store.createAPI(txKysely, this.#adapter))
              }
              return txStoreAPIs.get(name) as Stores[S]
            },
            hasStore: (name: string): boolean => this.#stores.has(name),
            onCommit: (hook: () => void) => {
              scopedCommitHooks.push(hook)
            },
            onRollback: (hook: () => void) => {
              scopedRollbackHooks.push(hook)
            },
            withTransaction: async <NestedStores extends Record<string, unknown>, R>(
              nestedFn: (tx: StoreProvider<NestedStores>) => Promise<R>,
            ): Promise<R> => {
              // Already inside a transaction — Kysely does not nest.
              // Run `nestedFn` inline with the same provider so its hooks and
              // writes remain within the enclosing transaction or savepoint.
              return await nestedFn(provider as unknown as StoreProvider<NestedStores>)
            },
            withSavepoint: async <NestedStores extends Record<string, unknown>, R>(
              nestedFn: (tx: StoreProvider<NestedStores>) => Promise<R>,
            ): Promise<R> => {
              if (savepointOpen) throw new SavepointOverlapError()
              savepointOpen = true
              try {
                const name = `${this.#tablePrefix}_sp_${++savepointID}`
                const savepointCommitHooks: Array<() => void> = []
                const savepointRollbackHooks: Array<() => void> = []
                const scopedProvider = createScopedProvider(
                  savepointCommitHooks,
                  savepointRollbackHooks,
                )
                await sql.raw(`SAVEPOINT ${name}`).execute(trx)
                try {
                  const value = await nestedFn(
                    scopedProvider as unknown as StoreProvider<NestedStores>,
                  )
                  await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(trx)
                  scopedCommitHooks.push(...savepointCommitHooks)
                  scopedRollbackHooks.push(...savepointRollbackHooks)
                  return value
                } catch (error) {
                  await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(trx)
                  await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(trx)
                  this.#runHooks(savepointRollbackHooks, 'rollback')
                  throw error
                }
              } finally {
                savepointOpen = false
              }
            },
          }
          return provider
        }

        return await fn(createScopedProvider(commitHooks, rollbackHooks))
      })
    } catch (err) {
      // Kysely issues ROLLBACK and rejects `execute()` when the callback
      // throws, so the DB is already reverted here. Run the rollback hooks to
      // drop any in-memory state that was eagerly advanced expecting a commit
      // (revert first, then drop the stale cache). Hooks are isolated/logged,
      // never re-thrown; the original error is preserved so callers (e.g. the
      // engine's `MutateGraphWriteRollback` sentinel) still observe it.
      this.#runHooks(rollbackHooks, 'rollback')
      throw err
    }

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

  #getMigrations(store: StoredDefinition): Record<string, Migration> {
    let migrations = this.#migrations.get(store.name)
    if (migrations == null) {
      migrations =
        typeof store.migrations === 'function'
          ? store.migrations({
              kind: this.#adapter.kind,
              types: this.#adapter.types,
              functions: this.#adapter.functions,
            })
          : store.migrations
      this.#migrations.set(store.name, migrations)
    }
    return migrations
  }

  #ensurePreflight(): Promise<void> {
    // Snapshot before awaiting so concurrent triggers share one read-only gate.
    this.#preflight ??= this.#runPreflight(Array.from(this.#stores.values()))
    return this.#preflight
  }

  async #runPreflight(stores: Array<StoredDefinition>): Promise<void> {
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
