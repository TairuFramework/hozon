# Database

`@hozon/db` exports `HozonDB`, `HozonDBParams`, `MigrationContext`, `StoreDefinition`, `BaseStoreContext`, `StoreContext`, `ContextFactory`, `StoreProvider`, `TablePrefixPlugin`, and `TablePrefixOptions`. It also exports `HozonDBClosedError`, `InvalidTablePrefixError`, `KeyLockScopeError`, `SavepointOverlapError`, `SchemaVersionError`, `IN_LIST_CHUNK`, `chunk`, `withKeepSet`, and `withStoreTransaction`.

It exports `CompareDefinition`, `compareText`, `withKeyLock`, and `withKeyLocks` for sync operations.

It also exports `createBatchLoader`, `BatchLoader`, `BatchLoaderParams`, `assertBatchSize`, `BatchLimitError`, `BatchReadOptions`, `iterateBatches`, and `IterateBatchesOptions`.

It re-exports the Kysely surface stores need, so store packages do not depend on `kysely` directly: the `Kysely` class and `sql` tag, and the types `ColumnType`, `Expression`, `Generated`, `Insertable`, `Migration` (from `kysely/migration`), `RawBuilder`, `Selectable`, `SelectQueryBuilder`, `Transaction`, and `Updateable`. Dialect authors still depend on `kysely` for `Dialect` and `Driver`.

```ts
type ContextExtension = object & { [Key in keyof BaseStoreContext]?: never }
type HozonDBParams<Ext extends ContextExtension = {}> = {
  adapter: Adapter; logger?: Logger; tablePrefix?: string
} & (keyof Ext extends never ? { context?: ContextFactory<Ext> } : { context: ContextFactory<Ext> })
type MigrationContext = {
  kind: Adapter['kind']; types: ColumnTypes; functions: Functions; tablePrefix: string
}
type BaseStoreContext = {
  compareWrite<T extends string>(table: T, row: Record<string, unknown>): Promise<{ changed: boolean }>
  createLoader<TKey, TValue>(params: BatchLoaderParams<TKey, TValue>): BatchLoader<TKey, TValue>
  provider: StoreProvider
  root: StoreProvider
  onClose(fn: () => Promise<void> | void): void
}
type StoreContext<Ext extends ContextExtension = {}> = BaseStoreContext & Ext
type ContextFactory<Ext extends ContextExtension> = (scope: {
  provider: StoreProvider
  root: StoreProvider
}) => Ext
type StoreDefinition<Tables, API, Ext extends ContextExtension = {}> = {
  name: string
  migrations: Record<string, Migration> | ((ctx: MigrationContext) => Record<string, Migration>)
  dependsOn?: Array<string>
  unprefixedTables?: (name: string) => boolean
  sync?: { [T in keyof Tables & string]?: CompareDefinition<Tables[T]> }
  createAPI: (db: Kysely<Tables>, adapter: Adapter, context: StoreContext<Ext>) => API
}
type StoreProvider<Stores extends Record<string, unknown> = Record<string, unknown>> = {
  readonly isTransactionBound: boolean
  readonly transactionRoot?: StoreProvider
  getStore<S extends keyof Stores & string>(name: S): Promise<Stores[S]>
  hasStore(name: string): boolean
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
  withTransaction<NestedStores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
  withScope?<NestedStores extends Record<string, unknown>, R>(
    fn: (scope: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
  withSavepoint?<NestedStores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
}
class HozonDB<Ext extends ContextExtension = {}> implements StoreProvider {
  constructor(params: HozonDBParams<Ext>)
  get adapter(): Adapter
  get isTransactionBound(): boolean
  get transactionRoot(): StoreProvider | undefined
  register<Tables, API>(store: StoreDefinition<Tables, API, Ext>): void
  getStore<T>(name: string): Promise<T>
  hasStore(name: string): boolean
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
  withTransaction<Stores extends Record<string, unknown>, R>(
    fn: (tx: StoreProvider<Stores>) => Promise<R>,
  ): Promise<R>
  withScope<NestedStores extends Record<string, unknown>, R>(
    fn: (scope: StoreProvider<NestedStores>) => Promise<R>,
  ): Promise<R>
  migrate(): Promise<void>
  close(): Promise<void>
}
function withStoreTransaction<DB, R>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<R>): Promise<R>
const IN_LIST_CHUNK = 500
function chunk<T>(
  items: Iterable<T>,
  size?: number, // defaults to IN_LIST_CHUNK
  options?: { unique?: boolean },
): Array<Array<T>>
function assertBatchSize(size: number, max: number, batchLimit?: number): void
function iterateBatches<TKey, TValue>(
  keys: Iterable<TKey>,
  load: (chunk: Array<TKey>) => Promise<Map<TKey, TValue | null>>,
  options: IterateBatchesOptions,
): AsyncGenerator<{ keys: Array<TKey>; results: Map<TKey, TValue | null> }>
function createBatchLoader<TKey, TValue>(
  params: BatchLoaderParams<TKey, TValue> & { remember: () => boolean },
): BatchLoader<TKey, TValue>
type BatchLoaderParams<TKey, TValue> = {
  load: (keys: Array<TKey>) => Promise<Map<TKey, TValue | null>>
  maxBatchSize: number
}
type BatchLoader<TKey, TValue> = {
  load(key: TKey): Promise<TValue | null>
  clear(key: TKey): void
  clearAll(): void
  dispatch(): void
}
```

The helper and error constructors have these declarations:

```ts
function withKeepSet<DB, R>(
  db: Kysely<DB>,
  params: { table: string; ids: Array<string> },
  fn: (selectKeep: () => SelectQueryBuilder<{ keep: { trace_id: string } }, 'keep', { trace_id: string }>) => Promise<R>,
): Promise<R>
class BatchLimitError extends Error { constructor(size: number, limit: number) }
class HozonDBClosedError extends Error { constructor() }
class InvalidTablePrefixError extends Error { constructor(prefix: string) }
class KeyLockScopeError extends Error { constructor() }
class SavepointOverlapError extends Error { constructor() }
class SchemaVersionError extends Error { constructor(store: string, unknown: Array<string>) }
type TablePrefixOptions = { unprefixed?: (name: string) => boolean }
class TablePrefixPlugin implements KyselyPlugin {
  constructor(prefix: string, options?: TablePrefixOptions)
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

## Store context extensions

`HozonDB<Ext>` supplies `StoreContext<Ext>` to store factories. The default extension is `{}`, with no context factory required.
A non-empty extension requires `params.context`, including when its fields are optional.
Extensions cannot declare `createLoader`, `provider`, `root`, `onClose`, or `compareWrite`.
`ContextExtension` above describes this constraint. It is not a package export.

The context factory receives the current provider and the root database instance.
It runs lazily when each store API is first created within a provider scope.
The root remains the actual `HozonDB` subclass instance in transactions and savepoints.
Property descriptors are preserved when composing the context, so getters remain live after API caching.
Stores can require the full extension, a subset, or only `BaseStoreContext`.
Registration rejects definitions requiring unavailable context fields.

```ts
type AppContext = { getTenant(): string }
class AppDB extends HozonDB<AppContext> {
  #tenant = 'default'

  constructor(params: { adapter: Adapter }) {
    super({ ...params, context: () => ({ getTenant: () => this.#tenant }) })
  }
}

const definition: StoreDefinition<Record<string, never>, () => string, AppContext> = {
  name: 'tenant',
  migrations: {},
  createAPI: (_db, _adapter, context) => () => context.getTenant(),
}
```

`context.provider` binds store callbacks to the current scope, including its commit and rollback hooks.
`context.root` identifies the root database through the `StoreProvider` type.
Subclass factories can capture `this` to access subclass methods and registries.

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

`isTransactionBound` is `false` on `HozonDB` and external `withScope` providers, with no `transactionRoot`.
Transaction and savepoint providers report `true`.
Their `transactionRoot` identifies the outermost transaction provider, shared across savepoints and inline scopes.
Independent transactions have distinct roots.
`transactionRoot` provides identity only, for example as a key for caller-owned state in a `WeakMap`.
It does not change loader ownership or dispatch.

WARNING: obtain all reading APIs through the supplied transaction or savepoint provider inside a transaction.
Root and external scope APIs retain their original executor, which can deadlock on single-connection SQLite when awaited inside a transaction.
Reads through the transaction provider complete on that connection.
`context.provider.isTransactionBound` reflects this binding, while `context.root.isTransactionBound` remains `false`.

Preflight checks schema versions before adapter preparation and migrations. Concurrent callers share one preflight attempt. A successful preflight is cached for the instance; a failed one (a check or `prepare()` rejection) is not, so the next `migrate()`, `getStore()` or `withTransaction()` reruns the read-only checks and then preparation. Every SQLite dialect is wrapped so migrations run in a transaction. A failed migration rolls back and retries on the next open. There is no per-driver opt-out. `withTransaction` passes a scoped provider to the callback. Store methods needing atomicity use `withStoreTransaction`; they do not call `.transaction()` directly. `withKeepSet` requires a transaction and serializes concurrent calls that share one transaction and keep-table name, in call order, so concurrent `deleteBefore` calls with keep lists inside one `withTransaction` both succeed. Its callback must not call `withKeepSet` for the same table.

Stores register database shutdown work with `context.onClose(fn)`.
`close()` awaits hooks in registration order before destroying Kysely and closing the adapter.
Each throwing or rejecting hook is logged. Remaining hooks and database closure continue.
Hooks belong to the root database, including registrations from transaction and savepoint APIs.
Repeated or concurrent `close()` calls share one shutdown, so each registration runs once.
`close()` marks the database closed before running hooks. New `getStore` calls reject, including cached transaction-scoped APIs.
`onClose` hooks always run outside any transaction. A captured transaction or savepoint Kysely instance has finished and cannot execute SQL.
Hooks needing SQL must use a root store API obtained through `context.root` before shutdown, or the root database's existing API.

```ts
// During API setup, before close starts:
const rootWriter = await context.root.getStore('writer') as WriterAPI
context.onClose(async () => { await rootWriter.flush() })
```

Commit and rollback hooks registered through released savepoint providers forward to the current parent.
Child savepoints opened through released providers also use that parent, including its hook registration methods.

## Chunking

`chunk(items: Iterable<T>, size = IN_LIST_CHUNK, options?: { unique?: boolean })` returns arrays of at most `size` values.
`IN_LIST_CHUNK` is the exported default, `500`, matching the statement parameter limit.
The size must be a positive integer. Invalid sizes throw `RangeError`.
Input iteration order is preserved. With `unique: true`, Set equality removes duplicates while preserving first-occurrence order.
Sparse array holes become `undefined`, following iterable semantics.

## Batch loading and scopes

Stores receive a `StoreContext` as the third `createAPI` argument. Existing two-argument definitions remain valid.
`context.createLoader({ load, maxBatchSize })` creates a per-store loader with `load(key)`, `dispatch()`, `clear(key)`, and `clearAll()`.
Same-tick calls coalesce into batches, split at `maxBatchSize`. Duplicate pending keys share a promise.
Sequential `await` loops do not batch. Start reads together, for example with `Promise.all`, to combine them.
A store's `load` must issue its query synchronously, without awaiting anything first, because boundary ordering relies on this.
It returns a `Map`, and keys with no record resolve `null`.

Base provider loaders remember no settled results. `db.withScope(fn)` gives the callback its own store instances and remembers results until the callback settles.
Each provider object has its own store API cache: root, external scope, transaction, and each savepoint.
Repeated `getStore` calls on one provider return the same API. Savepoint APIs differ from their outer transaction APIs.
Transactions share their Kysely instance and loader registry across savepoints, while each API creates its own loaders.
Nested `withScope` and `withTransaction` calls on transaction providers run inline with the same provider and API cache.
Nested `withScope` calls on external scopes also reuse their provider.
Scopes run `onCommit` immediately, ignore `onRollback`, and provide no `withSavepoint`.
Captured scope stores continue batching after the scope ends, but remember nothing.
External writes can leave remembered scope results stale.

A transaction opened through a scope has its own store instances.
Its commit clears the outer scope before commit hooks run.
Successful savepoint release invalidates remembered results across the entire transaction loader registry.
Savepoint rollback clears all transaction loaders before rollback hooks run.
Pending reads dispatch before savepoint creation, release, rollback, and transaction completion.

Batch reads call `assertBatchSize(size, max, options?.batchLimit)` before querying.
They return a `Map` containing every requested key, with `null` for missing records.
`BatchReadOptions` permits a lower `batchLimit`. Exceeding the limit throws `BatchLimitError`.
Invalid limits throw `RangeError`. No statement binds more than 500 parameters.
`iterateBatches(keys, load, { batchSize, signal? })` deduplicates keys and loads sequential chunks.
It yields `{ keys, results }` for each chunk and checks cancellation before each chunk.

Writes dispatch pending store reads before executing, then clear affected keys after success.
Writes affecting unknown keys call `clearAll()`. Clearing prevents late results from restoring stale remembered values.
The direct batch read is the fresh-read path: it always queries, bypassing remembered per-key results.
Use that path when re-reading state after acquiring a lock.

On a PostgreSQL pool outside a transaction, dispatch order does not guarantee execution order.
Concurrent reads and writes remain unordered. Writes do not wait for earlier reads.


## Sync primitives

`withKeyLock` serialises read, decide, and write callbacks for one key, including keys without a stored row.
`withKeyLocks` acquires several keys in a fixed order and ignores duplicates.
Both helpers open a transaction when the supplied provider is outside one.
Inside a transaction, callbacks receive a lock-scoped provider, preserving savepoint hooks and rollback boundaries.
That provider and its derived providers inherit ownership of the callback's held keys.
Nested acquisition passes through for owned keys and acquires new keys in sorted order.
Other providers in the same transaction still queue until the owning callback finishes.

```ts
function withKeyLock<R>(
  provider: StoreProvider,
  table: string,
  key: ReadonlyArray<string | number>,
  fn: (tx: StoreProvider) => Promise<R>,
): Promise<R>
function withKeyLocks<R>(
  provider: StoreProvider,
  table: string,
  keys: ReadonlyArray<ReadonlyArray<string | number>>,
  fn: (tx: StoreProvider) => Promise<R>,
): Promise<R>
```

Table names are logical names. Key components retain their string or number type. Numbers must be finite.
The transaction-local queue uses `transactionRoot`, shared by all store APIs and savepoint providers.
Postgres uses transaction-scoped advisory locks on the first 64 MD5 bits of the JSON-encoded prefix, table, and key.
Actual signed lock IDs are sorted and deduplicated before acquisition, including transaction-local queues.
Hash collisions add contention without weakening serialisation or changing lock order.
Postgres retains advisory locks until transaction completion, subject to savepoint rollback.
SQLite reserves its writer through a zero-row `DELETE` before invoking the callback, even when the key has no row.
SQLite therefore serialises writers across all keys.

WARNING: acquire all required keys together with `withKeyLocks` before reading.
Separate acquisitions can reverse the global lock order, including nested acquisitions that add keys.
An unsettled savepoint reserves every key it acquires until SQL release or rollback completes.
Acquiring a reserved key from outside that savepoint scope throws `KeyLockScopeError`.
After the savepoint settles, normal queueing resumes.
Callbacks must obtain store APIs from the supplied provider.
SQLite callers must acquire locks before establishing a read snapshot that another writer could invalidate.

A store declares ordered-column upserts per table:

```ts
type CompareDefinition<Row> = {
  key: Array<keyof Row & string>
  compare: Array<keyof Row & string>
  inclusive?: boolean
  nullsOldest?: boolean
  skipUnchanged?: boolean
  cursor?: never
  tombstones?: never
}

const sync = {
  records: { key: ['id'], compare: ['version', 'sequence'], inclusive: true },
} satisfies StoreDefinition<Tables, API>['sync']

// In createAPI, using the current context:
await context.compareWrite('records', row)

// In a migration, for each ordered text column:
query.schema.createTable('records').addColumn('version', 'text', compareText(ctx))
```

`compareWrite` issues one `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING` statement.
The declared key requires a matching unique constraint. Key and compare arrays must be nonempty.
Ordered columns compare lexicographically. A newer tuple updates every supplied column.
Equal tuples lose unless `inclusive` enables `>=`.
`nullsOldest` treats each NULL component as older than every non-NULL value, preserving lexicographic ordering.
Without it, SQL NULL comparison rules apply.
`skipUnchanged` adds a NULL-safe distinctness guard across supplied columns, suppressing updates with identical values.
The returned `{ changed }` is true for an insertion or accepted update and false when the conflict guard rejects it.
An undeclared table throws. A row exceeding 500 bound values throws before execution.
The row uses driver-ready values, as ordinary Kysely writes do. Store code remains responsible for loader invalidation.
`cursor` and `tombstones` remain reserved and cannot be declared.

`compareText(ctx)` returns a column modifier that adds `collate "C"` on Postgres and leaves SQLite columns unchanged.
Use it for ordered text columns to preserve byte ordering, including `'B' < 'a'`, across dialects.
