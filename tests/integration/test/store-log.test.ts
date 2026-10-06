import { HozonDB, withKeepSet } from '@hozon/db'
import { getLogStore, type LogStore, logStoreDefinition, type StoredLog } from '@hozon/store-log'
import { sql } from 'kysely'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'
import { type RawDB, rawStore, sampleLog, tracedLog } from '../src/helpers.js'

async function allLogs(store: LogStore, limit = 1000): Promise<Array<StoredLog>> {
  const logs: Array<StoredLog> = []
  let cursor: string | undefined
  do {
    const page = await store.queryLogs({ limit, cursor })
    logs.push(...page.logs)
    cursor = page.cursor
  } while (cursor !== undefined)
  return logs
}

describe.each(backends())('$name', (backend) => {
  const databases: Array<HozonDB> = []
  const openStore = async (reopen = false): Promise<{ db: HozonDB; store: LogStore }> => {
    const db = new HozonDB({
      adapter: reopen ? await backend.reopen() : await backend.createAdapter(),
    })
    databases.push(db)
    db.register(logStoreDefinition)
    return { db, store: await getLogStore(db) }
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  test('batch insert keeps every log in insertion order', async () => {
    const { store } = await openStore()
    const logs = Array.from({ length: 300 }, (_, index) =>
      sampleLog(1, `log ${index}`, { properties: { index, text: '保存 🗄️' } }),
    )
    await store.addLogs(logs)
    expect(await allLogs(store)).toEqual(logs)
  })

  test('unpaired trace and span IDs are rejected without writing', async () => {
    const { store } = await openStore()
    await expect(
      store.addLogs([sampleLog(1, 'ok'), sampleLog(2, 'trace only', { traceID: 'trace' })]),
    ).rejects.toThrow('Unpaired trace/span IDs at index 1')
    await expect(store.addLogs([sampleLog(1, 'span only', { spanID: 'span' })])).rejects.toThrow(
      'Unpaired trace/span IDs at index 0',
    )
    expect(await allLogs(store)).toEqual([])
  })

  test('queryLogs filters by time range, levels and traceID', async () => {
    const { store } = await openStore()
    const logs = [
      sampleLog(1, 'debug', { level: 'debug' }),
      tracedLog(2, 'traced', 'trace-a'),
      sampleLog(3, 'error', { level: 'error' }),
      { ...tracedLog(4, 'traced warning', 'trace-a'), level: 'warning' as const },
      tracedLog(5, 'other trace', 'trace-b'),
    ]
    await store.addLogs(logs)
    const query = async (params: Omit<Parameters<LogStore['queryLogs']>[0], 'limit'>) =>
      (await store.queryLogs({ ...params, limit: 100 })).logs
    expect(await query({ from: 2, to: 4 })).toEqual(logs.slice(1, 4))
    expect(await query({ from: 4 })).toEqual(logs.slice(3))
    expect(await query({ to: 1 })).toEqual(logs.slice(0, 1))
    expect(await query({ levels: ['error', 'warning'] })).toEqual([logs[2], logs[3]])
    expect(await query({ levels: [] })).toEqual([])
    expect(await query({ traceID: 'trace-a' })).toEqual([logs[1], logs[3]])
    expect(await query({ traceID: 'trace-a', levels: ['warning'], from: 3 })).toEqual([logs[3]])
  })

  test('categoryPrefix matches descendants only, with special and non-ASCII segments', async () => {
    const { store } = await openStore()
    const categories = [
      ['a'],
      ['a', 'b.c'],
      ['a', '%'],
      ['a', '_x'],
      ['a', '🦊'],
      ['a', '\u0001ctl'],
      ['a', 'tab\tbed', 'deep'],
      ['ab'],
      ['a.b'],
      ['a%'],
      ['a_'],
      ['a\u0001'],
      ['🦊'],
      ['🦊', 'child'],
      ['🦊x'],
    ]
    await store.addLogs(
      categories.map((category, index) => sampleLog(index, category.join('/'), { category })),
    )
    const matching = async (prefix: Array<string>) =>
      (await store.queryLogs({ categoryPrefix: prefix, limit: 100 })).logs.map(
        (log) => log.category,
      )
    expect(await matching(['a'])).toEqual(categories.slice(0, 7))
    expect(await matching(['a', '%'])).toEqual([['a', '%']])
    expect(await matching(['a', '_x'])).toEqual([['a', '_x']])
    expect(await matching(['a', 'b.c'])).toEqual([['a', 'b.c']])
    expect(await matching(['a', '🦊'])).toEqual([['a', '🦊']])
    expect(await matching(['a', '\u0001ctl'])).toEqual([['a', '\u0001ctl']])
    expect(await matching(['a', 'tab\tbed'])).toEqual([['a', 'tab\tbed', 'deep']])
    expect(await matching(['a%'])).toEqual([['a%']])
    expect(await matching(['a_'])).toEqual([['a_']])
    expect(await matching(['🦊'])).toEqual([['🦊'], ['🦊', 'child']])
    expect(await matching([])).toEqual(categories)
  })

  test('out-of-order inserts read back chronologically', async () => {
    const { store } = await openStore()
    const logs = [5, 1, 4, 2, 3].map((timestamp) => tracedLog(timestamp, `t${timestamp}`, 'trace'))
    await store.addLogs(logs.slice(0, 2))
    await store.addLogs(logs.slice(2))
    const expected = [...logs].sort((a, b) => a.timestamp - b.timestamp)
    expect(await allLogs(store)).toEqual(expected)
    expect(await store.getTraceLogs('trace')).toEqual(expected)
  })

  test('cursor pagination spans pages and equal timestamps', async () => {
    const { store } = await openStore()
    const logs = [
      sampleLog(1, 'first'),
      ...Array.from({ length: 23 }, (_, index) => sampleLog(2, `tie ${index}`)),
      sampleLog(3, 'last'),
    ]
    await store.addLogs(logs)
    const pages: Array<Array<StoredLog>> = []
    let cursor: string | undefined
    do {
      const page = await store.queryLogs({ limit: 10, cursor })
      pages.push(page.logs)
      cursor = page.cursor
    } while (cursor !== undefined)
    expect(pages.map((page) => page.length)).toEqual([10, 10, 5])
    expect(pages.flat()).toEqual(logs)
  })

  test('getTraceLogs returns only the trace, ordered', async () => {
    const { store } = await openStore()
    const logs = [
      tracedLog(3, 'third', 'trace'),
      tracedLog(1, 'first', 'trace'),
      tracedLog(2, 'other', 'other'),
      sampleLog(2, 'untraced'),
      tracedLog(2, 'second', 'trace'),
    ]
    await store.addLogs(logs)
    expect((await store.getTraceLogs('trace')).map((log) => log.message)).toEqual([
      'first',
      'second',
      'third',
    ])
    expect(await store.getTraceLogs('missing')).toEqual([])
  })

  test('deleteByTrace removes more than 500 traces', async () => {
    const { store } = await openStore()
    const traceIDs = Array.from({ length: 1_200 }, (_, index) => `trace-${index}`)
    await store.addLogs([
      ...traceIDs.map((traceID) => tracedLog(1, traceID, traceID)),
      tracedLog(1, 'survivor', 'survivor'),
      sampleLog(1, 'untraced'),
    ])
    expect(await store.deleteByTrace(traceIDs)).toBe(1_200)
    expect((await allLogs(store)).map((log) => log.message)).toEqual(['survivor', 'untraced'])
  })

  test('deleteBefore keeps 40,000 trace IDs and deletes old untraced logs', async () => {
    const { store } = await openStore()
    const keepTraceIDs = Array.from({ length: 40_000 }, (_, index) => `keep-${index}`)
    const kept = [...keepTraceIDs.slice(0, 300), keepTraceIDs.at(-1) as string]
    await store.addLogs([
      ...kept.map((traceID) => tracedLog(1, traceID, traceID)),
      tracedLog(1, 'old traced', 'drop'),
      sampleLog(1, 'old untraced'),
      tracedLog(10, 'new traced', 'recent'),
      sampleLog(10, 'new untraced'),
    ])
    expect(await store.deleteBefore(5, { keepTraceIDs })).toBe(2)
    const messages = (await allLogs(store)).map((log) => log.message)
    expect(messages).toEqual([...kept, 'new traced', 'new untraced'])
    expect(await store.deleteBefore(5, { keepTraceIDs: [] })).toBe(0)
    expect(await store.deleteBefore(5)).toBe(kept.length)
  })

  test('logs persist across reopen', async () => {
    const first = await openStore()
    const logs = [tracedLog(1, 'persisted', 'trace'), sampleLog(2, 'untraced')]
    await first.store.addLogs(logs)
    await first.db.close()
    const second = await openStore(true)
    expect(await allLogs(second.store)).toEqual(logs)
    expect(await second.store.getTraceLogs('trace')).toEqual([logs[0]])
  })

  test('a failing keep-set operation surfaces its own error, not the cleanup error', async () => {
    const { db } = await openStore()
    db.register(rawStore)
    await db.migrate()
    const failure = db.withTransaction<{ raw: RawDB }, void>(async (tx) => {
      const trx = await tx.getStore('raw')
      return withKeepSet(trx, { table: 'hozon_keep_failure', ids: ['a', 'b'] }, async () => {
        // On Postgres this aborts the transaction, so the keep table DROP fails as well.
        await sql`SELECT * FROM missing_table_for_keep_set`.execute(trx)
      })
    })
    await expect(failure).rejects.toThrow(/missing_table_for_keep_set/)
    // The transaction rolled back cleanly: the store still works and the keep table is gone.
    const store = await getLogStore(db)
    await store.addLogs([sampleLog(1, 'after failure')])
    expect(await store.deleteBefore(2, { keepTraceIDs: ['x'] })).toBe(1)
  })
})
