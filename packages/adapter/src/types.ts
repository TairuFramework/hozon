import type { ColumnDataType, ColumnType, Dialect, Expression, RawBuilder } from 'kysely'

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

export type AbstractAdapter<T extends AdapterTypes = AdapterTypes> = {
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
