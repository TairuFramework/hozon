import type { ColumnDataType, ColumnType, Dialect, Expression, Kysely, RawBuilder } from 'kysely'

export type OrderDirection = 'asc' | 'desc'
export type ArrayPresenceMode = 'null' | 'nonNull' | 'empty' | 'nonEmpty' | 'nullOrEmpty'
export type NullOrderingTerm = { kind: 'lead'; expression: Expression<number> } | { kind: 'native' }
export type CreatedAtColumn = ColumnType<number, number | undefined, never>
export type UpdatedAtColumn = ColumnType<number, number | undefined, number | undefined>

export type ColumnTypes = {
  bigint: ColumnDataType
  binary: ColumnDataType
  boolean: ColumnDataType
  double: ColumnDataType
  json: ColumnDataType
  serial: ColumnDataType
  text: ColumnDataType
  timestamp: ColumnDataType
  uuid: ColumnDataType
}

export type Functions = { now: string | RawBuilder<string> }
export type AdapterTypes = { Binary: unknown; JSON: unknown; Timestamp: unknown }

/** Keys are text, matching the owning table's referenced column. */
export type SearchIndex = {
  index: string
  table: string
  key: string
  fields: Array<string>
}

export type SearchEntry = {
  index: string
  key: string
  fields: Record<string, string>
}

export type SearchQuery = { index: string; query: string; limit: number }
export type SearchHit = { key: string; rank: number }

/**
 * Logical table names follow the supplied database's prefix rules.
 * Query syntax and rank scales are dialect-specific. No method opens a transaction.
 */
export type SearchCapability = {
  createIndex<Database>(db: Kysely<Database>, params: SearchIndex): Promise<void>
  dropIndex<Database>(db: Kysely<Database>, params: { index: string }): Promise<void>
  upsertEntry<Database>(db: Kysely<Database>, params: SearchEntry): Promise<void>
  removeEntry<Database>(db: Kysely<Database>, params: { index: string; key: string }): Promise<void>
  query<Database>(db: Kysely<Database>, params: SearchQuery): Promise<Array<SearchHit>>
}

export type AbstractAdapter<T extends AdapterTypes = AdapterTypes> = {
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
  arrayIncludesAllPredicate(
    expression: Expression<unknown>,
    values: Array<unknown>,
  ): RawBuilder<boolean>
  arrayIncludesAnyPredicate(
    expression: Expression<unknown>,
    values: Array<unknown>,
  ): RawBuilder<boolean>
  arrayPresencePredicate(
    expression: Expression<unknown>,
    mode: ArrayPresenceMode,
  ): RawBuilder<boolean>
  prepare?(): Promise<void>
  close?(): Promise<void>
}

export type Adapter<T extends AdapterTypes = AdapterTypes> = AbstractAdapter<T> & {
  dialect: Dialect
}
