import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { SchemaVersionError } from './errors.js'

/** Names of the migrations recorded for a store, or `null` when its migration table is absent. */
export async function readAppliedMigrations<DB>(
  db: Kysely<DB>,
  prefix: string,
  name: string,
): Promise<Set<string> | null> {
  try {
    const result = await sql<{
      name: string
    }>`SELECT name FROM ${sql.table(`${prefix}_${name}_migration`)}`.execute(db)
    return new Set(result.rows.map((row) => row.name))
  } catch (error) {
    // Only a missing table is a fresh schema. Connection and permission errors must surface.
    if (
      error instanceof Error &&
      (('code' in error && error.code === '42P01') || /no such table:/i.test(error.message))
    ) {
      return null
    }
    throw error
  }
}

export async function checkStore<DB>(
  db: Kysely<DB>,
  prefix: string,
  name: string,
  keys: Array<string>,
): Promise<void> {
  const applied = await readAppliedMigrations(db, prefix, name)
  if (applied == null) return
  const known = new Set(keys)
  const unknown = [...applied].filter((key) => !known.has(key)).sort()
  if (unknown.length > 0) throw new SchemaVersionError(name, unknown)
}
