import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from 'kysely'
import { describe, expect, test } from 'vitest'

import { AbstractSQLiteAdapter } from '../src/index.js'

type Database = Record<string, never>

class TestSQLiteAdapter extends AbstractSQLiteAdapter {
  dialect = {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db: Kysely<unknown>) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  }
}

const adapter = new TestSQLiteAdapter()
const db = new Kysely<Database>({ dialect: adapter.dialect })

describe('AbstractSQLiteAdapter', () => {
  test('kind and column types', () => {
    expect(adapter.kind).toBe('sqlite')
    expect(adapter.types.boolean).toBe('integer')
    expect(adapter.types.double).toBe('real')
  })

  test('numericCast compiles to REAL', () => {
    expect(sql`${adapter.numericCast(sql.ref('x'))}`.compile(db).sql).toContain('CAST("x" AS REAL)')
  })

  test('keeps dialect-specific seams', () => {
    expect(adapter.containsPredicate(sql.ref('x'), '%a%').compile(db).sql).toContain('LIKE')
    expect(adapter.nullOrdering(sql.ref('x'), 'asc').kind).toBe('lead')
    expect(adapter.coerceFilterValue(true)).toBe(1)
  })

  test('array predicates never compile an empty IN list', () => {
    const any = adapter.arrayIncludesAnyPredicate(sql.ref('x'), []).compile(db)
    const all = adapter.arrayIncludesAllPredicate(sql.ref('x'), []).compile(db)
    for (const compiled of [any, all]) {
      expect(compiled.sql).not.toMatch(/IN \(\s*\)/)
      expect(compiled.parameters).toEqual([])
    }
  })

  test('array includes all binds each distinct value once', () => {
    const compiled = adapter
      .arrayIncludesAllPredicate(sql.ref('x'), ['a', 'a', 2, 2, 'b'])
      .compile(db)
    expect(compiled.parameters).toEqual(['a', 2, 'b', 3])
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
