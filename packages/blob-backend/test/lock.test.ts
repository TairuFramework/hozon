import { expect, test } from 'vitest'

import { createMemoryBlobLock } from '../src/lock.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test('same ID runs sequentially', async () => {
  const lock = createMemoryBlobLock()
  const events: Array<string> = []
  const run = (name: string) =>
    lock.withLock('a', async () => {
      events.push(`${name}:start`)
      await tick()
      events.push(`${name}:end`)
    })
  await Promise.all([run('1'), run('2')])
  expect(events).toEqual(['1:start', '1:end', '2:start', '2:end'])
})

test('different IDs overlap', async () => {
  const lock = createMemoryBlobLock()
  const events: Array<string> = []
  const run = (id: string) =>
    lock.withLock(id, async () => {
      events.push(`${id}:start`)
      await tick()
      events.push(`${id}:end`)
    })
  await Promise.all([run('a'), run('b')])
  expect(events.slice(0, 2)).toEqual(['a:start', 'b:start'])
})

test('rejection releases the lock', async () => {
  const lock = createMemoryBlobLock()
  await expect(
    lock.withLock('a', async () => {
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect(await lock.withLock('a', async () => 'ok')).toBe('ok')
})

test('return values pass through', async () => {
  const lock = createMemoryBlobLock()
  expect(await lock.withLock('a', async () => 42)).toBe(42)
})
