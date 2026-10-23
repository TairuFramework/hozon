# Adapter

`@hozon/adapter` defines the common SQLite and PostgreSQL adapter contract. The package entry exports `AbstractSQLiteAdapter`, `AbstractPostgresAdapter`, `SQLiteTypes`, `PostgresTypes`, `AbstractAdapter`, `Adapter`, `AdapterTypes`, `ColumnTypes`, `Functions`, `OrderDirection`, `NullOrderingTerm`, `ArrayPresenceMode`, `CreatedAtColumn`, and `UpdatedAtColumn`.

Adapters provide `kind`, `dialect`, `functions`, `types`, value encoders and decoders, `coerceFilterValue`, numeric casts, null ordering, `containsPredicate`, array inclusion and array presence predicates. The optional `prepare()` and `close()` hooks support connection setup and teardown.

```ts
type AbstractAdapter<T extends AdapterTypes = AdapterTypes> = {
  kind: 'sqlite' | 'postgres'
  search?: SearchCapability
  functions: Functions
  types: ColumnTypes
  encodeBinary(value: Uint8Array): T['Binary']
  encodeJSON(value: unknown): T['JSON']
  encodeTimestamp(value: Date): T['Timestamp']
  decodeTimestamp(value: T['Timestamp']): Date
  coerceFilterValue(value: unknown): unknown
  numericCast(expression: Expression<unknown>): Expression<number>
  nullOrdering(expression: Expression<unknown>, direction: OrderDirection): NullOrderingTerm
  containsPredicate(expression: Expression<unknown>, pattern: string): RawBuilder<boolean>
  arrayIncludesAllPredicate(expression: Expression<unknown>, values: Array<unknown>): RawBuilder<boolean>
  arrayIncludesAnyPredicate(expression: Expression<unknown>, values: Array<unknown>): RawBuilder<boolean>
  arrayPresencePredicate(expression: Expression<unknown>, mode: ArrayPresenceMode): RawBuilder<boolean>
  prepare?(): Promise<void>
  close?(): Promise<void>
}
type Adapter<T extends AdapterTypes = AdapterTypes> = AbstractAdapter<T> & { dialect: Dialect }
```

The entry also exports both abstract adapter classes and every supporting type. Their declarations are:

```ts
type OrderDirection = 'asc' | 'desc'
type ArrayPresenceMode = 'null' | 'nonNull' | 'empty' | 'nonEmpty' | 'nullOrEmpty'
type NullOrderingTerm = { kind: 'lead'; expression: Expression<number> } | { kind: 'native' }
type CreatedAtColumn = ColumnType<number, number | undefined, never>
type UpdatedAtColumn = ColumnType<number, number | undefined, number | undefined>
type ColumnTypes = {
  bigint: ColumnDataType; binary: ColumnDataType; boolean: ColumnDataType
  double: ColumnDataType; json: ColumnDataType; serial: ColumnDataType
  text: ColumnDataType; timestamp: ColumnDataType; uuid: ColumnDataType
}
type Functions = { now: string | RawBuilder<string> }
type AdapterTypes = { Binary: unknown; JSON: unknown; Timestamp: unknown }
type SQLiteTypes = { Binary: Uint8Array; JSON: string; Timestamp: number }
type PostgresTypes = { Binary: Uint8Array; JSON: unknown; Timestamp: string }
abstract class AbstractSQLiteAdapter<T extends AdapterTypes = SQLiteTypes>
  implements AbstractAdapter<T> {
  search: SearchCapability | undefined
  kind: 'sqlite'; functions: Functions; types: ColumnTypes
  encodeBinary(value: Uint8Array): T['Binary']; encodeJSON(value: unknown): T['JSON']
  encodeTimestamp(value: Date): T['Timestamp']; decodeTimestamp(value: T['Timestamp']): Date
  coerceFilterValue(value: unknown): unknown
  numericCast(expression: Expression<unknown>): Expression<number>
  nullOrdering(expression: Expression<unknown>, direction: OrderDirection): NullOrderingTerm
  containsPredicate(expression: Expression<unknown>, pattern: string): RawBuilder<boolean>
  arrayIncludesAllPredicate(expression: Expression<unknown>, values: Array<unknown>): RawBuilder<boolean>
  arrayIncludesAnyPredicate(expression: Expression<unknown>, values: Array<unknown>): RawBuilder<boolean>
  arrayPresencePredicate(expression: Expression<unknown>, mode: ArrayPresenceMode): RawBuilder<boolean>
  prepare?(): Promise<void>; close?(): Promise<void>
}
abstract class AbstractPostgresAdapter<T extends AdapterTypes = PostgresTypes>
  implements AbstractAdapter<T> {
  search: SearchCapability
  kind: 'postgres'; functions: Functions; types: ColumnTypes
  encodeBinary(value: Uint8Array): T['Binary']; encodeJSON(value: unknown): T['JSON']
  encodeTimestamp(value: Date): T['Timestamp']; decodeTimestamp(value: T['Timestamp']): Date
  coerceFilterValue(value: unknown): unknown
  numericCast(expression: Expression<unknown>): Expression<number>
  nullOrdering(expression: Expression<unknown>, direction: OrderDirection): NullOrderingTerm
  containsPredicate(expression: Expression<unknown>, pattern: string): RawBuilder<boolean>
  arrayIncludesAllPredicate(expression: Expression<unknown>, values: Array<unknown>): RawBuilder<boolean>
  arrayIncludesAnyPredicate(expression: Expression<unknown>, values: Array<unknown>): RawBuilder<boolean>
  arrayPresencePredicate(expression: Expression<unknown>, mode: ArrayPresenceMode): RawBuilder<boolean>
  prepare?(): Promise<void>; close?(): Promise<void>
}
```

`containsPredicate` accepts a SQL `LIKE` pattern, such as `%needle%`. Array inclusion predicates bind one parameter per value. Hozon's own statements stay within the 500-parameter limit, but callers must chunk large value lists passed to these predicates.

Array inclusion semantics are identical on every backend and covered by the shared conformance suite:

- `arrayIncludesAnyPredicate(expression, [])` is always false. No `IN ()` is emitted.
- `arrayIncludesAllPredicate(expression, [])` is always true (vacuous truth, matching SQL/JSON array containment), including rows whose array is `NULL`.
- `arrayIncludesAllPredicate` ignores duplicate values: `['a', 'a']` behaves like `['a']`. Values are deduplicated before binding.

See [drivers](drivers.md) for concrete adapters and [database lifecycle](db.md) for preparation order.

## Optional full-text search

`adapter.search?: SearchCapability` exposes generic full-text search without store or graph concepts.
The package exports `SearchCapability`, `SearchIndex`, `SearchEntry`, `SearchQuery`, and `SearchHit`.

```ts
type SearchIndex = { index: string; table: string; key: string; fields: Array<string> }
type SearchEntry = { index: string; key: string; fields: Record<string, string> }
type SearchQuery = { index: string; query: string; limit: number }
type SearchHit = { key: string; rank: number }
type SearchCapability = {
  createIndex<Database>(db: Kysely<Database>, params: SearchIndex): Promise<void>
  dropIndex<Database>(db: Kysely<Database>, params: { index: string }): Promise<void>
  upsertEntry<Database>(db: Kysely<Database>, params: SearchEntry): Promise<void>
  removeEntry<Database>(db: Kysely<Database>, params: { index: string; key: string }): Promise<void>
  query<Database>(db: Kysely<Database>, params: SearchQuery): Promise<Array<SearchHit>>
}
```

`SearchIndex.key` names the owning table's text primary or unique column.
Entry and removal keys contain its text value. Search tables use an internal `entry_key` column.
Only creation requires owning-table metadata. Every query executes exactly one statement, without metadata lookups.
Creation and dropping are idempotent. Creation preserves the original field configuration and does not evolve schemas.

Index and field names accept ASCII letters, digits, and underscores, beginning with a letter or underscore, within 63 bytes.
Field lists contain 1–499 distinct names, compared case-insensitively.
Fields cannot use `entry_key`, `rank`, `rowid`, or the index name, compared case-insensitively.
Upserts supply the complete configured field record, using empty strings for missing values.
Each statement binds at most 500 parameters, including the entry key.

No capability method opens a transaction. Callers pass their existing transaction to each operation.
SQLite replacement deletes then inserts, requiring a caller transaction for atomicity.
Store methods use `withStoreTransaction` for this boundary.

Query syntax and ranking are dialect-specific, with no portability guarantee.
SQLite uses FTS5 `MATCH`, including prefix and phrase syntax, and ascending native rank.
PostgreSQL concatenates `simple` dictionary vectors, queries with `plainto_tsquery`, and orders descending `ts_rank`.
PostgreSQL does not provide SQLite's prefix or phrase semantics. Rank signs and scales differ between dialects.
Both implementations break rank ties by entry key in their database's text order.

PostgreSQL enforces the owning-table foreign key and cascades owning-row deletion.
SQLite virtual tables cannot enforce that foreign key. Callers explicitly remove SQLite search entries when deleting owning rows.

Table references use `sql.table`, and column identifiers use `sql.id`, preserving the supplied database's prefix rules.
Stores can declare `unprefixedTables: (name) => name.startsWith('fts_')` to preserve long dynamic index names.
The complete physical table name must fit PostgreSQL's 63-byte limit, including any prefix.
Exempt names share the schema namespace. Callers must ensure those names are globally unique within that schema.

PostgreSQL GIN names use `search_` plus a deterministic 64-bit hash of the compiled physical table reference.
These names fit within 23 bytes. Hash collisions are accepted as negligible, without collision detection or resolution.
A collision can cause `CREATE INDEX IF NOT EXISTS` to skip a GIN index, affecting query performance rather than search results.
No migration or compatibility handling is provided for existing search schemas.
