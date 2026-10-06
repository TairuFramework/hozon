# Adapter

`@hozon/adapter` defines the common SQLite and PostgreSQL adapter contract. The package entry exports `AbstractSQLiteAdapter`, `AbstractPostgresAdapter`, `SQLiteTypes`, `PostgresTypes`, `AbstractAdapter`, `Adapter`, `AdapterTypes`, `ColumnTypes`, `Functions`, `OrderDirection`, `NullOrderingTerm`, `ArrayPresenceMode`, `CreatedAtColumn`, and `UpdatedAtColumn`.

Adapters provide `kind`, `dialect`, `functions`, `types`, value encoders and decoders, `coerceFilterValue`, numeric casts, null ordering, `containsPredicate`, array inclusion and array presence predicates. The optional `prepare()` and `close()` hooks support connection setup and teardown.

```ts
type AbstractAdapter<T extends AdapterTypes = AdapterTypes> = {
  kind: 'sqlite' | 'postgres'
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
