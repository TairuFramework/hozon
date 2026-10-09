# Database

`@hozon/db` exports `HozonDB`, `HozonDBParams`, `MigrationContext`, `StoreDefinition`, `StoreProvider`, and `TablePrefixPlugin`. It also exports `HozonDBClosedError`, `InvalidTablePrefixError`, `SavepointOverlapError`, `SchemaVersionError`, `chunk`, `withKeepSet`, and `withStoreTransaction`.

It re-exports the Kysely surface stores need, so store packages do not depend on `kysely` directly: the `Kysely` class and `sql` tag, and the types `ColumnType`, `Expression`, `Generated`, `Insertable`, `Migration` (from `kysely/migration`), `RawBuilder`, `Selectable`, `SelectQueryBuilder`, `Transaction`, and `Updateable`. Dialect authors still depend on `kysely` for `Dialect` and `Driver`.

```ts
type HozonDBParams = { adapter: Adapter; logger?: Logger; tablePrefix?: string }
type MigrationContext = {
  kind: Adapter['kind']; types: ColumnTypes; functions: Functions; tablePrefix: string
}
type StoreDefinition<Tables, API> = {
  name: string
  migrations: Record<string, Migration> | ((ctx: MigrationContext) => Record<string, Migration>)
  dependsOn?: Array<string>
  unprefixedTables?: (name: string) => boolean
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
class TablePrefixPlugin implements KyselyPlugin {
  constructor(prefix: string)
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode
  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>>
}
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

## JSON results

`HozonDB` leaves query results in the driver's native representation. It does not install a global JSON results parser.
Stores decode known JSON columns once with `JSON.parse` when the driver returns text.
They retain objects already decoded by the driver, including PostgreSQL JSONB results.
Nested strings remain strings even when they contain valid JSON. Plain text columns remain text.
Custom stores must decode their own JSON columns at the read boundary.

## Table prefixes

`tablePrefix` configures store tables and migration tables for the whole database.
The default is `hozon`, validated against `^[a-z][a-z0-9_]{0,30}$`.
Migration tables are `<prefix>_<store>_migration` and `<prefix>_<store>_migration_lock`.
Savepoints use `<prefix>_sp_N`.

`HozonDB` applies the exported `TablePrefixPlugin` to store `createAPI` instances and store migrations, including transaction-scoped APIs.
The Kysely `Migrator` uses an instance without the plugin, preventing double prefixes on migration tables.
The plugin prefixes unqualified table names once, including subqueries, joins, schema builders, and raw `sql.table()` references.
Qualified `sql.ref()` references follow explicit table references in raw templates.
Aliases, visible CTE read references, and schema-qualified names stay unchanged.
Nonrecursive CTE definitions see preceding CTEs. Physical write targets always receive the prefix.
Literal table names embedded in raw SQL strings are not rewritten.

Store APIs, migrations, and `Tables` type keys use logical, unprefixed names.
For example, `logs` becomes `hozon_logs` by default or `app_logs` with `tablePrefix: 'app'`.
The default physical names for existing stores remain unchanged.
Databases created with a non-default `tablePrefix` must be reset because store tables move from `hozon_*` to `<prefix>_*`.
Keep-set tables use logical names `keep_log` and `keep_telemetry`.
Index and constraint names use `ctx.tablePrefix`, for example `${ctx.tablePrefix}_logs_timestamp`.
The plugin does not rewrite index or constraint names.

A store can keep some tables outside the prefix with `unprefixedTables`, a predicate over logical table names.
`HozonDB` gives that store its own plugin, built with `new TablePrefixPlugin(prefix, { unprefixed })`, for its migrations, its API, and its transaction-scoped API.
Use it for dynamic tables whose prefixed names would exceed identifier length limits, such as Postgres's 63 bytes.
For example, `unprefixedTables: (name) => name.startsWith('k_')` keeps `k_<modelID>` as is.
Matching tables lose the namespace, so the store must keep them collision-free, including across databases that share one schema with different prefixes.
Other stores still prefix the same names, and migration tables always use the prefix.

WARNING: never reference system tables through the store instance.
The plugin would prefix unqualified names such as `sqlite_master` or `information_schema`.

## Transactions and lifecycle

Preflight checks schema versions before adapter preparation and migrations. Concurrent callers share one preflight attempt. A successful preflight is cached for the instance; a failed one (a check or `prepare()` rejection) is not, so the next `migrate()`, `getStore()` or `withTransaction()` reruns the read-only checks and then preparation. Every SQLite dialect is wrapped so migrations run in a transaction. A failed migration rolls back and retries on the next open. There is no per-driver opt-out. `withTransaction` passes a scoped provider to the callback. Store methods needing atomicity use `withStoreTransaction`; they do not call `.transaction()` directly. `withKeepSet` requires a transaction and serializes concurrent calls that share one transaction and keep-table name, in call order, so concurrent `deleteBefore` calls with keep lists inside one `withTransaction` both succeed. Its callback must not call `withKeepSet` for the same table.
