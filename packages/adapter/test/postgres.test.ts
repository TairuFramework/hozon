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
    expect(compiled.parameters).toEqual(['["a",2,"b"]'])
  })

  test('has no graph-specific search or access seams', () => {
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

test('search upserts bind at most 500 parameters', async () => {
  const counts: Array<number> = []
  const observed = new Kysely<Database>({
    dialect: adapter.dialect,
    log(event) {
      if (event.level === 'query') counts.push(event.query.parameters.length)
    },
  })
  const search = adapter.search
  expect(search).toBeDefined()
  if (search === undefined) throw new Error('Missing search')
  try {
    const fields = Object.fromEntries(Array.from({ length: 499 }, (_, i) => [`f${i}`, 'text']))
    await search.upsertEntry(observed, { index: 'fts_documents', key: 'a', fields })
    expect(counts).toEqual([500])
    await expect(
      search.upsertEntry(observed, {
        index: 'fts_documents',
        key: 'a',
        fields: { ...fields, overflow: 'text' },
      }),
    ).rejects.toThrow('1 to 499')
    expect(counts).toEqual([500])
  } finally {
    await observed.destroy()
  }
})
