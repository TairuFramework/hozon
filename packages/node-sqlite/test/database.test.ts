import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'

import { type WrappedDatabase, wrapDatabase } from '../src/database.js'

const LARGE_ROW_ID = 9_007_199_254_740_993n

describe('wrapDatabase run metadata', () => {
  let database: WrappedDatabase | undefined

  afterEach(() => {
    database?.close()
    database = undefined
  })

  test('returns row IDs beyond the safe integer range as bigint and keeps the connection usable', () => {
    database = wrapDatabase(new DatabaseSync(':memory:'))
    database.prepare('CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT)').run([])

    const inserted = database.prepare('INSERT INTO changes (seq) VALUES (?)').run([LARGE_ROW_ID])
    expect(inserted).toEqual({ changes: 1, lastInsertRowid: LARGE_ROW_ID })

    // The connection's last-insert row ID stays large for every later statement.
    expect(database.prepare('BEGIN').run([]).lastInsertRowid).toBe(LARGE_ROW_ID)
    const next = database.prepare('INSERT INTO changes DEFAULT VALUES').run([])
    expect(next).toEqual({ changes: 1, lastInsertRowid: LARGE_ROW_ID + 1n })
    database.prepare('COMMIT').run([])

    const rows = database
      .prepare('SELECT CAST(seq AS TEXT) AS seq FROM changes ORDER BY seq')
      .all([])
    expect(rows).toEqual([{ seq: String(LARGE_ROW_ID) }, { seq: String(LARGE_ROW_ID + 1n) }])
  })

  test('keeps safe row IDs and change counts as numbers', () => {
    database = wrapDatabase(new DatabaseSync(':memory:'))
    database.prepare('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)').run([])

    expect(database.prepare('INSERT INTO items (label) VALUES (?)').run(['a'])).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    })
    expect(database.prepare("UPDATE items SET label = 'b'").run([])).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    })
  })

  test('reads integer columns as numbers after a large-metadata run', () => {
    database = wrapDatabase(new DatabaseSync(':memory:'))
    database.prepare('CREATE TABLE items (id INTEGER PRIMARY KEY, count INTEGER)').run([])
    database.prepare('INSERT INTO items (id, count) VALUES (?, ?)').run([LARGE_ROW_ID, 3])

    expect(database.prepare('SELECT count FROM items').all([])).toEqual([{ count: 3 }])
  })
})
