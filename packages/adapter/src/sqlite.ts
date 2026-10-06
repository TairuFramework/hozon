import type { Expression, RawBuilder } from 'kysely'
import { sql } from 'kysely'

import type {
  AbstractAdapter,
  AdapterTypes,
  ArrayPresenceMode,
  ColumnTypes,
  Functions,
  NullOrderingTerm,
  OrderDirection,
} from './types.js'

export type SQLiteTypes = {
  Binary: Uint8Array
  JSON: string
  Timestamp: number
}

export abstract class AbstractSQLiteAdapter<T extends AdapterTypes = SQLiteTypes>
  implements AbstractAdapter<T>
{
  kind = 'sqlite' as const
  functions = {
    now: sql<string>`(unixepoch())`,
  } as Functions

  types = {
    bigint: 'integer',
    boolean: 'integer',
    double: 'real',
    binary: 'blob',
    json: 'jsonb',
    serial: 'integer',
    text: 'text',
    timestamp: 'integer',
    uuid: 'text',
  } as ColumnTypes

  encodeBinary(value: Uint8Array) {
    return value
  }

  encodeJSON(value: unknown) {
    return JSON.stringify(value)
  }

  encodeTimestamp(value: Date) {
    // SQLite timestamps are stored in seconds
    return Math.floor(value.getTime() / 1000)
  }

  decodeTimestamp(value: number) {
    // SQLite timestamps are stored in seconds
    return new Date(value * 1000)
  }

  coerceFilterValue(value: unknown): unknown {
    if (typeof value === 'boolean') {
      return value ? 1 : 0
    }
    return value
  }

  numericCast(expression: Expression<unknown>): Expression<number> {
    return sql<number>`CAST(${expression} AS REAL)`
  }

  nullOrdering(expression: Expression<unknown>, direction: OrderDirection): NullOrderingTerm {
    // SQLite has no NULLS LAST/FIRST clause, so prepend an ascending rank column that
    // buckets nulls last on ascending (rank 1 > 0) and first on descending (rank 0 < 1).
    const nullRank = direction === 'asc' ? 1 : 0
    const valueRank = direction === 'asc' ? 0 : 1
    return {
      kind: 'lead',
      expression: sql<number>`CASE WHEN ${expression} IS NULL THEN ${sql.lit(nullRank)} ELSE ${sql.lit(valueRank)} END`,
    }
  }

  containsPredicate(expression: Expression<unknown>, pattern: string): RawBuilder<boolean> {
    // SQLite's LIKE is already ASCII case-insensitive by default.
    return sql<boolean>`${expression} LIKE ${pattern} ESCAPE '\\'`
  }

  arrayIncludesAllPredicate(
    expression: Expression<unknown>,
    values: Array<unknown>,
  ): RawBuilder<boolean> {
    // NULL/absent node -> json_each yields zero rows -> COUNT(DISTINCT value) = 0, never
    // equal to a positive set size.
    return sql<boolean>`(SELECT COUNT(DISTINCT value) FROM json_each(COALESCE(${expression}, '[]')) WHERE value IN (${sql.join(values.map((v) => sql`${v}`))})) = ${values.length}`
  }

  arrayIncludesAnyPredicate(
    expression: Expression<unknown>,
    values: Array<unknown>,
  ): RawBuilder<boolean> {
    return sql<boolean>`EXISTS (SELECT 1 FROM json_each(COALESCE(${expression}, '[]')) WHERE value IN (${sql.join(values.map((v) => sql`${v}`))}))`
  }

  arrayPresencePredicate(
    expression: Expression<unknown>,
    mode: ArrayPresenceMode,
  ): RawBuilder<boolean> {
    // null/nonNull/empty/nonEmpty must see the true NULL, so the node is never coalesced
    // there — json_array_length(NULL) is NULL, and NULL > 0 is not-true (excludes it).
    switch (mode) {
      case 'null':
        return sql<boolean>`${expression} IS NULL`
      case 'nonNull':
        return sql<boolean>`${expression} IS NOT NULL`
      case 'empty':
        return sql<boolean>`json_array_length(${expression}) = 0`
      case 'nonEmpty':
        return sql<boolean>`json_array_length(${expression}) > 0`
      case 'nullOrEmpty':
        return sql<boolean>`COALESCE(json_array_length(${expression}), 0) = 0`
      default:
        throw new Error(`Invalid array presence mode: ${mode as string}`)
    }
  }
}
