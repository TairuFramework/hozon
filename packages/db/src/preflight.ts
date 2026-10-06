import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { SchemaVersionError } from './errors.js'

export async function checkStore<DB>(
  db: Kysely<DB>,
  prefix: string,
  name: string,
  keys: Array<string>,
): Promise<void> {
  let rows: Array<{ name: string }>
  try {
    const result = await sql<{
      name: string
    }>`SELECT name FROM ${sql.table(`${prefix}_${name}_migration`)}`.execute(db)
    rows = result.rows
  } catch (error) {
    // Only a missing table is a fresh schema. Connection and permission errors must surface.
    if (
      error instanceof Error &&
      (('code' in error && error.code === '42P01') || /no such table:/i.test(error.message))
    ) {
      return
    }
    throw error
  }
  const known = new Set(keys)
  const unknown = rows
    .map((row) => row.name)
    .filter((key) => !known.has(key))
    .sort()
  if (unknown.length > 0) throw new SchemaVersionError(name, unknown)
}
