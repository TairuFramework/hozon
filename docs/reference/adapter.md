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

`SQLiteTypes` and `PostgresTypes` specialise the adapter's binary, JSON, and timestamp values. The exported column, function, ordering, and presence types describe the members above.

`containsPredicate` accepts a SQL `LIKE` pattern, such as `%needle%`. Array inclusion predicates bind one parameter per value. Hozon's own statements stay within the 500-parameter limit, but callers must chunk large value lists passed to these predicates.

See [drivers](drivers.md) for concrete adapters and [database lifecycle](db.md) for preparation order.
