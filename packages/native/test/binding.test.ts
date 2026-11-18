import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { loadBinding } from './binding.js'

const sqlite = loadBinding()
const options = { readers: 4, busyTimeoutMs: 5000, journalMode: 'wal' } as const

test('boundary validates handles, mode, bigint range and unsafe numbers', async () => {
  const db = await sqlite.open(':memory:', options)
  try {
    expect(() => sqlite.execute('bad', null, 'SELECT 1', [], 'read')).toThrow('HOZON_INVALID_INPUT')
    expect(() => sqlite.execute(db, null, 'SELECT ?', [9223372036854775808n], 'read')).toThrow(
      'i64',
    )
    expect(() =>
      sqlite.execute(db, null, 'SELECT ?', [Number.MAX_SAFE_INTEGER + 1], 'read'),
    ).toThrow('unsafe integer')
    await expect(sqlite.execute(db, null, 'SELECT ?', [], 'read')).rejects.toThrow('HOZON_SQLITE')
    await expect(sqlite.execute(db, '999999999', 'SELECT 1', [], 'read')).rejects.toThrow(
      'HOZON_INVALID_TRANSACTION',
    )
    await expect(
      sqlite.execute(db, null, 'SELECT ?', [new Uint8Array([1])], 'read'),
    ).resolves.toMatchObject({ rows: [[new Uint8Array([1])]] })
    expect(
      (
        await sqlite.execute(
          db,
          null,
          'SELECT ?, ?, ?',
          [-9223372036854775808n, 2147483648n, 1.25],
          'read',
        )
      ).rows,
    ).toEqual([[-9223372036854775808n, 2147483648n, 1.25]])
    await expect(
      sqlite.execute(db, null, 'SELECT * FROM missing_table', [], 'read'),
    ).rejects.toThrow('HOZON_SQLITE')
  } finally {
    await sqlite.close(db)
  }
})

test('admission diagnostics include the calling and holding JS stacks', async () => {
  const db = await sqlite.open(':memory:', options)
  async function holderSite() {
    return sqlite.beginWrite(db).granted
  }
  async function callerSite() {
    return sqlite.beginWrite(db, { timeoutMs: 30 }).granted
  }
  const holder = await holderSite()
  try {
    await expect(callerSite()).rejects.toThrow(/HOZON_ADMISSION_EXPIRED:.*callerSite.*holderSite/s)
  } finally {
    await sqlite.rollback(db, holder.txID)
    await sqlite.close(db)
  }
})

test('close rolls back active rows on disk and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hozon-native-'))
  const path = join(directory, 'test.db')
  let db = await sqlite.open(path, options)
  try {
    await sqlite.execute(db, null, 'CREATE TABLE rows (id INTEGER)', [], 'write')
    const tx = await sqlite.beginWrite(db).granted
    await sqlite.execute(db, tx.txID, 'INSERT INTO rows VALUES (1)', [], 'write')
    const pending = sqlite.beginWrite(db).granted.then(
      () => 'unexpected grant',
      (error: unknown) => error,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await sqlite.close(db)
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('closed')
    await sqlite.close(db)
    db = await sqlite.open(path, options)
    expect((await sqlite.execute(db, null, 'SELECT * FROM rows', [], 'read')).rows).toEqual([])
  } finally {
    await sqlite.close(db)
    await rm(directory, { recursive: true, force: true })
  }
})

test('clean close checkpoints committed WAL data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hozon-checkpoint-'))
  const path = join(directory, 'test.db')
  const db = await sqlite.open(path, options)
  try {
    await sqlite.execute(db, null, 'CREATE TABLE rows (id INTEGER)', [], 'write')
    await sqlite.execute(db, null, 'INSERT INTO rows VALUES (1)', [], 'write')
    await sqlite.close(db)
    // A checkpointed close either removes the WAL or leaves it truncated.
    const wal = await readFile(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return new Uint8Array()
      throw error
    })
    expect(wal.byteLength).toBe(0)
  } finally {
    await sqlite.close(db)
    await rm(directory, { recursive: true, force: true })
  }
})

test('boundary rejects fractional option values before dispatch', async () => {
  const attempt = async () => {
    const db = await sqlite.open(':memory:', { ...options, readers: 1.5 })
    await sqlite.close(db)
  }
  await expect(attempt()).rejects.toThrow('readers')
})

test('beginWrite synchronously returns a cancellable pending admission object', async () => {
  const db = await sqlite.open(':memory:', options)
  try {
    const holder = await sqlite.beginWrite(db).granted
    const pending = sqlite.beginWrite(db, { timeoutMs: 1000 })
    // Observe rejection even while asserting the synchronous contract.
    const outcome = pending.granted.catch((error: unknown) => error)
    expect(pending).not.toBeInstanceOf(Promise)
    expect(pending.admissionID).toEqual(expect.any(String))
    expect(pending.granted).toBeInstanceOf(Promise)
    await sqlite.abandon(db, pending.admissionID)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringContaining('abandoned') })
    await sqlite.execute(db, holder.txID, 'SELECT 1', [], 'read')
    await sqlite.rollback(db, holder.txID)
    const next = sqlite.beginWrite(db)
    const grant = await next.granted
    expect(grant.admissionID).toBe(next.admissionID)
    await sqlite.abandon(db, next.admissionID)
    await expect(sqlite.execute(db, grant.txID, 'SELECT 1', [], 'read')).rejects.toThrow(
      'HOZON_INVALID_TRANSACTION',
    )
  } finally {
    await sqlite.close(db)
  }
})
