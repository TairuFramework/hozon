# Database

`@hozon/db` exports `HozonDB`, `HozonDBParams`, `MigrationContext`, `StoreDefinition`, and `StoreProvider`. It also exports `HozonDBClosedError`, `InvalidTablePrefixError`, `SavepointOverlapError`, `SchemaVersionError`, `chunk`, `withKeepSet`, and `withStoreTransaction`.

```ts
type HozonDBParams = { adapter: Adapter; logger?: Logger; tablePrefix?: string }
type MigrationContext = { kind: Adapter['kind']; types: ColumnTypes; functions: Functions }
type StoreDefinition<Tables, API> = {
  name: string
  migrations: Record<string, Migration> | ((ctx: MigrationContext) => Record<string, Migration>)
  dependsOn?: Array<string>
  createAPI: (db: Kysely<Tables>, adapter: Adapter) => API
}
type StoreProvider<Stores extends Record<string, unknown> = Record<string, unknown>> = {
  getStore<S extends keyof Stores & string>(name: S): Promise<Stores[S]>
  hasStore(name: string): boolean
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
  withTransaction<NestedStores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
  withSavepoint?<NestedStores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
}
class HozonDB implements StoreProvider {
  constructor(params: HozonDBParams)
  get adapter(): Adapter
  register<Tables, API>(store: StoreDefinition<Tables, API>): void
  getStore<T>(name: string): Promise<T>
  hasStore(name: string): boolean
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
  withTransaction<Stores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<Stores>) => Promise<R>,
  ): Promise<R>
  migrate(): Promise<void>
  close(): Promise<void>
}
function withStoreTransaction<DB, R>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<R>): Promise<R>
function chunk<T>(items: Array<T>, size?: number): Array<Array<T>>
```

The helper and error constructors have these declarations:

```ts
function withKeepSet<DB, R>(
  db: Kysely<DB>,
  params: { table: string; ids: Array<string> },
  fn: (selectKeep: () => SelectQueryBuilder<{ keep: { trace_id: string } }, 'keep', { trace_id: string }>) => Promise<R>,
): Promise<R>
class HozonDBClosedError extends Error { constructor() }
class InvalidTablePrefixError extends Error { constructor(prefix: string) }
class SavepointOverlapError extends Error { constructor() }
class SchemaVersionError extends Error { constructor(store: string, unknown: Array<string>) }
```

Create a database with an adapter, register store definitions, then request a store or call `migrate()`:

```ts
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { logStoreDefinition, getLogStore } from '@hozon/store-log'

const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: 'app.sqlite' }) })
db.register(logStoreDefinition)
const logs = await getLogStore(db)
await db.close()
```

The default migration prefix is `hozon`, validated against `^[a-z][a-z0-9_]{0,30}$`. Migration tables are `<prefix>_<store>_migration` and `<prefix>_<store>_migration_lock`; savepoints use `<prefix>_sp_N`. Stores use fixed table names and cannot be duplicated by changing this prefix.

Preflight checks schema versions before adapter preparation and migrations. Concurrent callers share one preflight attempt. A successful preflight is cached for the instance; a failed one (a check or `prepare()` rejection) is not, so the next `migrate()`, `getStore()` or `withTransaction()` reruns the read-only checks and then preparation. Every SQLite dialect is wrapped so migrations run in a transaction. A failed migration rolls back and retries on the next open. There is no per-driver opt-out. `withTransaction` passes a scoped provider to the callback. Store methods needing atomicity use `withStoreTransaction`; they do not call `.transaction()` directly. `withKeepSet` requires a transaction and serializes concurrent calls that share one transaction and keep-table name, in call order, so concurrent `deleteBefore` calls with keep lists inside one `withTransaction` both succeed. Its callback must not call `withKeepSet` for the same table.
