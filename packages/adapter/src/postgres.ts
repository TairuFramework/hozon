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

export type PostgresTypes = {
  Binary: Uint8Array
  JSON: unknown
  Timestamp: string
}

export abstract class AbstractPostgresAdapter<T extends AdapterTypes = PostgresTypes>
  implements AbstractAdapter<T>
{
  kind = 'postgres' as const
  functions = {
    now: 'now()',
  } as Functions

  types = {
    bigint: 'bigint',
    boolean: 'boolean',
    double: 'double precision',
    binary: 'bytea',
    json: 'jsonb',
    serial: 'serial',
    text: 'text',
    // Use 3 digits for timestamps to have millisecond precision, same as JS dates
    timestamp: 'timestamptz(3)',
    uuid: 'uuid',
  } as ColumnTypes

  encodeBinary(value: Uint8Array) {
    return value
  }

  encodeJSON(value: unknown) {
    return value
  }

  encodeTimestamp(value: Date) {
    return value.toISOString()
  }

  decodeTimestamp(value: string) {
    return new Date(value)
  }

  coerceFilterValue(value: unknown): unknown {
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false'
    }
    return value
  }

  numericCast(expression: Expression<unknown>): Expression<number> {
    return sql<number>`(${expression})::double precision`
  }

  nullOrdering(_expression: Expression<unknown>, _direction: OrderDirection): NullOrderingTerm {
    // Postgres applies SQL-standard null position natively (NULLS LAST on asc, NULLS
    // FIRST on desc) via the dialect's own clause on the field's order-by item.
    return { kind: 'native' }
  }

  containsPredicate(expression: Expression<unknown>, pattern: string): RawBuilder<boolean> {
    return sql<boolean>`${expression} ILIKE ${pattern} ESCAPE '\\'`
  }

  arrayIncludesAllPredicate(
    expression: Expression<unknown>,
    values: Array<unknown>,
  ): RawBuilder<boolean> {
    // Native jsonb containment: works for string and numeric elements alike. NULL node
    // coalesces to an empty array, which is a subset only of another empty set.
    // Cast via ::text::jsonb, not a direct ::jsonb: postgres.js infers the parameter's
    // wire type from a trailing ::jsonb cast and re-encodes the JS string as a jsonb
    // *string scalar* instead of sending it as text for the server to parse, so a
    // direct ::jsonb cast silently never matches. The ::text hop forces text encoding.
    return sql<boolean>`COALESCE(${expression}, '[]'::jsonb) @> ${JSON.stringify(values)}::text::jsonb`
  }

  arrayIncludesAnyPredicate(
    expression: Expression<unknown>,
    values: Array<unknown>,
  ): RawBuilder<boolean> {
    // Elements, not `?|`, so numeric arrays are covered too (`?|` only matches string keys).
    return sql<boolean>`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${expression}, '[]'::jsonb)) AS _t WHERE _t IN (${sql.join(values.map((v) => sql`${v}`))}))`
  }

  arrayPresencePredicate(
    expression: Expression<unknown>,
    mode: ArrayPresenceMode,
  ): RawBuilder<boolean> {
    // null/nonNull/empty/nonEmpty must see the true NULL, so the node is never coalesced
    // there — jsonb_array_length(NULL) is NULL, and NULL > 0 is not-true (excludes it).
    switch (mode) {
      case 'null':
        return sql<boolean>`${expression} IS NULL`
      case 'nonNull':
        return sql<boolean>`${expression} IS NOT NULL`
      case 'empty':
        return sql<boolean>`jsonb_array_length(${expression}) = 0`
      case 'nonEmpty':
        return sql<boolean>`jsonb_array_length(${expression}) > 0`
      case 'nullOrEmpty':
        return sql<boolean>`COALESCE(jsonb_array_length(${expression}), 0) = 0`
      default:
        throw new Error(`Invalid array presence mode: ${mode as string}`)
    }
  }
}
