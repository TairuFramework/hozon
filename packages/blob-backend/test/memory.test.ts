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

test('sequential staging preserves accepted bytes when the upload buffer is reused', async () => {
  const backend = new MemoryBlobBackend()
  const writer = (await backend.createStaging('s1')).getWriter()
  const bytes = new Uint8Array([0, 1])
  await writer.write(bytes)
  bytes.set([2, 3])
  await writer.write(bytes)
  bytes.fill(9)
  await writer.close()
  await backend.commit('s1', 'k')
  bytes.fill(8)
  expect(await readBytes(await backend.createReadStream('k'))).toEqual([0, 1, 2, 3])
})

test('writeChunk preserves accepted bytes when the upload buffer is reused', async () => {
  const backend = new MemoryBlobBackend()
  const bytes = new Uint8Array([2, 3])
  await backend.writeChunk('s1', 2, bytes)
  bytes.set([0, 1])
  await backend.writeChunk('s1', 0, bytes)
  bytes.fill(9)
  await backend.commit('s1', 'k')
  bytes.fill(8)
  expect(await readBytes(await backend.createReadStream('k'))).toEqual([0, 1, 2, 3])
})

test.each([
  { name: 'full', range: undefined, expected: [0, 1, 2, 3, 4] },
  { name: 'ranged', range: { start: 1, end: 3 }, expected: [1, 2, 3] },
])(
  '$name read output can be mutated without changing committed bytes',
  async ({ range, expected }) => {
    const backend = new MemoryBlobBackend()
    await backend.writeChunk('s1', 0, new Uint8Array([0, 1, 2, 3, 4]))
    await backend.commit('s1', 'k')
    const reader = (await backend.createReadStream('k', range)).getReader()
    const { value } = await reader.read()
    expect(value).toEqual(new Uint8Array(expected))
    if (value == null) {
      throw new Error('Expected read output')
    }
    value.fill(9)
    expect((await reader.read()).done).toBe(true)
    expect(await readBytes(await backend.createReadStream('k'))).toEqual([0, 1, 2, 3, 4])
    expect(await readBytes(await backend.createReadStream('k', { start: 1, end: 3 }))).toEqual([
      1, 2, 3,
    ])
  },
)

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
