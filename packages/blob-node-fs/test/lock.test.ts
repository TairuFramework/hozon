import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobLockTimeoutError } from '@hozon/blob-backend'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createFileBlobLock } from '../src/lock.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hozon-blob-lock-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const fixture = join(import.meta.dirname, 'fixtures/lock-child.ts')

// Spawns a child holding the lock; resolves once it reports "locked".
function holdInChild(id: string, holdMs: number): Promise<{ exited: Promise<number | null> }> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', fixture, directory, id, String(holdMs)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.stdout.on('data', (data: Buffer) => {
      if (data.toString().includes('locked')) resolve({ exited })
    })
    void exited.then((code) => reject(new Error(`child exited early: ${code}`)))
  })
}

test('two withLock calls for one id in a process serialize', async () => {
  const lock = createFileBlobLock(directory)
  const events: Array<string> = []
  const run = (name: string) =>
    lock.withLock('id', async () => {
      events.push(`${name}:start`)
      await new Promise((resolve) => setTimeout(resolve, 30))
      events.push(`${name}:end`)
    })
  await Promise.all([run('a'), run('b')])
  expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
})

test('returns the value of fn and propagates its errors', async () => {
  const lock = createFileBlobLock(directory)
  expect(await lock.withLock('id', async () => 42)).toBe(42)
  await expect(
    lock.withLock('id', async () => {
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect(await lock.withLock('id', async () => 1)).toBe(1)
})

test('a lock held by another process blocks until released', async () => {
  const { exited } = await holdInChild('id', 400)
  const lock = createFileBlobLock(directory)
  const startedAt = Date.now()
  await lock.withLock('id', async () => {})
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
  await exited
})

test('rejects with BlobLockTimeoutError when acquireTimeoutMs elapses', async () => {
  const { exited } = await holdInChild('id', 600)
  const lock = createFileBlobLock(directory, { acquireTimeoutMs: 50 })
  await expect(lock.withLock('id', async () => {})).rejects.toBeInstanceOf(BlobLockTimeoutError)
  await exited
})

test('does not wrap errors thrown by fn', async () => {
  const lock = createFileBlobLock(directory, { acquireTimeoutMs: 50 })
  const error = new Error('mine')
  await expect(
    lock.withLock('id', async () => {
      throw error
    }),
  ).rejects.toBe(error)
})

test('lock file is <directory>/<id>.lock', async () => {
  const lock = createFileBlobLock(directory)
  const { access } = await import('node:fs/promises')
  await lock.withLock('abc', async () => {
    await access(join(directory, 'abc.lock'))
  })
})

test('rejects unsafe ids', async () => {
  const lock = createFileBlobLock(directory)
  for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a:b', '../x']) {
    await expect(lock.withLock(id, async () => {})).rejects.toThrow('Invalid blob key')
  }
})
