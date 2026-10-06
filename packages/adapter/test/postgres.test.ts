import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely'
import { describe, expect, test } from 'vitest'

import { AbstractPostgresAdapter } from '../src/index.js'

type Database = Record<string, never>

class TestPostgresAdapter extends AbstractPostgresAdapter {
  dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  }
}

const adapter = new TestPostgresAdapter()
const db = new Kysely<Database>({ dialect: adapter.dialect })

describe('AbstractPostgresAdapter', () => {
  test('kind and column types', () => {
    expect(adapter.kind).toBe('postgres')
    expect(adapter.types.boolean).toBe('boolean')
    expect(adapter.types.double).toBe('double precision')
  })

  test('numericCast compiles to double precision', () => {
    const compiled = sql`${adapter.numericCast(sql.ref('x'))}`.compile(db).sql
    expect(compiled).toContain('::double precision')
    expect(compiled).not.toContain('::numeric')
  })

  test('keeps dialect-specific seams', () => {
    expect(adapter.containsPredicate(sql.ref('x'), '%a%').compile(db).sql).toContain('ILIKE')
    expect(adapter.nullOrdering(sql.ref('x'), 'asc').kind).toBe('native')
    expect(adapter.coerceFilterValue(true)).toBe('true')
  })

  test('has no search or access seams', () => {
    for (const key of [
      'createSearchIndex',
      'dropSearchIndex',
      'updateSearchEntry',
      'removeSearchEntry',
      'searchIndex',
      'readAccessPredicate',
    ]) {
      expect(key in adapter).toBe(false)
    }
  })
})
