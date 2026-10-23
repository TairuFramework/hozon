import type { Expression, RawBuilder } from 'kysely'
import { sql } from 'kysely'

import { assertSearchFields, assertSearchIndex } from './search.js'
import type {
  AbstractAdapter,
  AdapterTypes,
  ArrayPresenceMode,
  ColumnTypes,
  Functions,
  NullOrderingTerm,
  OrderDirection,
  SearchCapability,
} from './types.js'

export type SQLiteTypes = {
  Binary: Uint8Array
  JSON: string
  Timestamp: number
}

export abstract class AbstractSQLiteAdapter<T extends AdapterTypes = SQLiteTypes>
  implements AbstractAdapter<T>
{
  search: SearchCapability | undefined = {
    async createIndex(db, params) {
      assertSearchIndex(params.index)
      assertSearchFields(params.fields, params.index)
      const columns = [sql`entry_key UNINDEXED`, ...params.fields.map((f) => sql.id(f))]
      await sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.table(params.index)} USING fts5(${sql.join(columns)})`.execute(
        db,
      )
    },
    async dropIndex(db, { index }) {
      assertSearchIndex(index)
      await sql`DROP TABLE IF EXISTS ${sql.table(index)}`.execute(db)
    },
    async upsertEntry(db, { index, key, fields }) {
      assertSearchIndex(index)
      assertSearchFields(Object.keys(fields), index)
      // Delete and insert share the caller's transaction for atomic replacement.
      await sql`DELETE FROM ${sql.table(index)} WHERE entry_key = ${key}`.execute(db)
      await sql`INSERT INTO ${sql.table(index)} (${sql.join([sql.id('entry_key'), ...Object.keys(fields).map((f) => sql.id(f))])}) VALUES (${sql.join([key, ...Object.values(fields)])})`.execute(
        db,
      )
    },
    async removeEntry(db, { index, key }) {
      assertSearchIndex(index)
      await sql`DELETE FROM ${sql.table(index)} WHERE entry_key = ${key}`.execute(db)
    },
    async query(db, { index, query, limit }) {
      assertSearchIndex(index)
      const result = await sql<{ key: string; rank: number }>`
        SELECT entry_key AS key, rank FROM ${sql.table(index)}
        WHERE ${sql.table(index)} MATCH ${query}
        ORDER BY rank, entry_key LIMIT ${limit}
      `.execute(db)
      return result.rows
    },
  }

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
    // Duplicates are ignored (the count compares against the distinct set size) and an
    // empty list is vacuously true — identical on every backend.
    const distinct = Array.from(new Set(values))
    if (distinct.length === 0) return sql<boolean>`1 = 1`
    // NULL/absent node -> json_each yields zero rows -> COUNT(DISTINCT value) = 0, never
    // equal to a positive set size.
    return sql<boolean>`(SELECT COUNT(DISTINCT value) FROM json_each(COALESCE(${expression}, '[]')) WHERE value IN (${sql.join(distinct.map((v) => sql`${v}`))})) = ${distinct.length}`
  }

  arrayIncludesAnyPredicate(
    expression: Expression<unknown>,
    values: Array<unknown>,
  ): RawBuilder<boolean> {
    // An empty list matches nothing; never emit `IN ()` (portable with Postgres).
    if (values.length === 0) return sql<boolean>`1 = 0`
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
