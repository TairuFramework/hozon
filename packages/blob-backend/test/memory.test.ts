import { expect, test } from 'vitest'

import { MemoryBlobBackend } from '../src/memory.js'

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Array<number>> {
  const reader = stream.getReader()
  const bytes: Array<number> = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      return bytes
    }
    bytes.push(...value)
  }
}

test('sequential staging then commit reads back the bytes', async () => {
  const backend = new MemoryBlobBackend()
  const writer = (await backend.createStaging('s1')).getWriter()
  await writer.write(new Uint8Array([0, 1, 2]))
  await writer.write(new Uint8Array([3, 4]))
  await writer.close()
  expect(await backend.has('k')).toBe(false)
  await backend.commit('s1', 'k')
  expect(await backend.has('k')).toBe(true)
  expect(await readBytes(await backend.createReadStream('k'))).toEqual([0, 1, 2, 3, 4])
  await expect(backend.commit('s1', 'other')).rejects.toThrow('No staging area for s1')
})

test('out-of-order writeChunk assembles by offset', async () => {
  const backend = new MemoryBlobBackend()
  await backend.writeChunk('s1', 4, new Uint8Array([4, 5, 6, 7]))
  await backend.writeChunk('s1', 0, new Uint8Array([0, 1, 2, 3]))
  await backend.commit('s1', 'k')
  expect(await readBytes(await backend.createReadStream('k'))).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
})

test('commit is idempotent for an existing key and drops the staging area', async () => {
  const backend = new MemoryBlobBackend()
  await backend.writeChunk('s1', 0, new Uint8Array([1, 2]))
  await backend.commit('s1', 'k')
  await backend.writeChunk('s2', 0, new Uint8Array([3, 4]))
  await backend.commit('s2', 'k')
  await backend.commit('s2', 'k')
  expect(await readBytes(await backend.createReadStream('k'))).toEqual([1, 2])
  await expect(backend.commit('s2', 'other')).rejects.toThrow('No staging area for s2')
})

test('commit without staging throws "No staging area for s1"', async () => {
  const backend = new MemoryBlobBackend()
  await expect(backend.commit('s1', 'k')).rejects.toThrow('No staging area for s1')
})

test('ranged read is inclusive', async () => {
  const backend = new MemoryBlobBackend()
  await backend.writeChunk('s1', 0, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
  await backend.commit('s1', 'k')
  expect(await readBytes(await backend.createReadStream('k', { start: 2, end: 4 }))).toEqual([
    2, 3, 4,
  ])
})

test('read of a missing key throws "No blob for key k"', async () => {
  const backend = new MemoryBlobBackend()
  await expect(backend.createReadStream('k')).rejects.toThrow('No blob for key k')
})

test('delete then has() is false; getURL() is null', async () => {
  const backend = new MemoryBlobBackend()
  await backend.writeChunk('s1', 0, new Uint8Array([1]))
  await backend.commit('s1', 'k')
  expect(await backend.has('k')).toBe(true)
  expect(await backend.getURL('k')).toBeNull()
  await backend.delete('k')
  expect(await backend.has('k')).toBe(false)
  expect(await backend.getURL('k')).toBeNull()
})

test('abortStaging drops staged bytes and can be repeated', async () => {
  const backend = new MemoryBlobBackend()
  await backend.writeChunk('s1', 0, new Uint8Array([1]))
  await backend.abortStaging('s1')
  await backend.abortStaging('s1')
  await expect(backend.commit('s1', 'k')).rejects.toThrow('No staging area for s1')
  expect(await backend.has('k')).toBe(false)
})
