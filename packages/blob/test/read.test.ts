import type { BlobBackend } from '@hozon/blob-backend'
import { InvalidBlobIDError } from '@hozon/blob-id'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { BlobNotFoundError, InvalidRangeError } from '../src/index.js'
import {
  backendFactories,
  bytesOf,
  createTestService,
  sourceOf,
  type TestService,
} from './helpers.js'

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe.each(backendFactories)('read ($name)', (factory) => {
  let backend: BlobBackend
  let cleanup: () => Promise<void>
  let ctx: TestService

  beforeEach(async () => {
    ;({ backend, cleanup } = await factory.create())
    ctx = await createTestService({ backend, chunkSize: 4096 })
  })
  afterEach(async () => {
    await ctx.db.close()
    await cleanup()
  })

  async function put(length: number, seed = 0) {
    const data = bytesOf(length, seed)
    const { entry } = await ctx.service.write({ stream: sourceOf(data).stream })
    return { data, id: entry.blobID }
  }

  test('exposes codec and limits', () => {
    expect(ctx.service.codec.digestLength).toBeGreaterThan(0)
    expect(ctx.service.limits.maxBlobSize).toBe(1024 ** 3)
  })

  test('get, has and getChunkDigests', async () => {
    const { id } = await put(5000)
    expect((await ctx.service.get(id))?.blobID).toBe(id)
    expect(await ctx.service.has(id)).toBe(true)
    expect(await ctx.service.getChunkDigests(id)).toHaveLength(2)
    expect(
      await ctx.service.get(
        ctx.service.codec.encode({ digest: new Uint8Array(32), contentLength: 1 }),
      ),
    ).toBeNull()
  })

  test('getChunkDigests returns [] for non-local entries', async () => {
    const id = ctx.service.codec.encode({ digest: new Uint8Array(32).fill(3), contentLength: 8 })
    await ctx.store.insertEntry(
      { blobID: id, contentLength: 8, chunkSize: 4, state: 'remote-only', createdAt: 5 },
      [],
    )
    await ctx.store.beginTransfer({
      blobID: id,
      chunkSize: 4,
      chunks: [
        { index: 0, digest: new Uint8Array(32).fill(1) },
        { index: 1, digest: new Uint8Array(32).fill(2) },
      ],
      stagingID: 't-x',
    })
    expect(await ctx.store.getChunkDigests(id)).toHaveLength(2)
    expect(await ctx.service.getChunkDigests(id)).toEqual([])
  })

  test('limits are frozen', () => {
    expect(Object.isFrozen(ctx.service.limits)).toBe(true)
  })

  test('list pages entries', async () => {
    await put(10, 1)
    await put(10, 2)
    await put(10, 3)
    const first = await ctx.service.list({ limit: 2 })
    expect(first.entries).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await ctx.service.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.entries).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
  })

  test('uppercase IDs resolve to the same blob', async () => {
    const { data, id } = await put(20)
    const upper = id.toUpperCase()
    expect((await ctx.service.get(upper))?.blobID).toBe(id)
    expect(await ctx.service.has(upper)).toBe(true)
    expect(await ctx.service.getChunkDigests(upper)).toHaveLength(1)
    expect(await readAll(await ctx.service.createReadStream(upper))).toEqual(data)
    await ctx.service.setPinned(upper, true)
    expect((await ctx.service.get(id))?.pinned).toBe(true)
    expect(await ctx.service.delete(upper)).toBe(true)
    expect(await ctx.service.get(id)).toBeNull()
  })

  test('invalid IDs throw InvalidBlobIDError', async () => {
    const bad = 'not-an-id'
    await expect(ctx.service.get(bad)).rejects.toThrow(InvalidBlobIDError)
    await expect(ctx.service.has(bad)).rejects.toThrow(InvalidBlobIDError)
    await expect(ctx.service.getChunkDigests(bad)).rejects.toThrow(InvalidBlobIDError)
    await expect(ctx.service.createReadStream(bad)).rejects.toThrow(InvalidBlobIDError)
    await expect(ctx.service.setPinned(bad, true)).rejects.toThrow(InvalidBlobIDError)
    await expect(ctx.service.delete(bad)).rejects.toThrow(InvalidBlobIDError)
  })

  test('createReadStream full and ranged', async () => {
    const { data, id } = await put(100)
    expect(await readAll(await ctx.service.createReadStream(id))).toEqual(data)
    expect(await readAll(await ctx.service.createReadStream(id, { start: 2, end: 5 }))).toEqual(
      data.slice(2, 6),
    )
  })

  test('invalid ranges throw InvalidRangeError', async () => {
    const { id } = await put(100)
    await expect(ctx.service.createReadStream(id, { start: 0, end: 100 })).rejects.toThrow(
      InvalidRangeError,
    )
    await expect(ctx.service.createReadStream(id, { start: 5, end: 4 })).rejects.toThrow(
      InvalidRangeError,
    )
    await expect(ctx.service.createReadStream(id, { start: -1, end: 4 })).rejects.toThrow(
      InvalidRangeError,
    )
  })

  test('zero-length blob reads empty', async () => {
    const { id } = await put(0)
    expect((await readAll(await ctx.service.createReadStream(id))).length).toBe(0)
  })

  test('remote-only and partial entries are not readable', async () => {
    const remote = bytesOf(10, 9)
    const partial = bytesOf(10, 10)
    const remoteID = ctx.service.codec.encode({
      digest: new Uint8Array(32).fill(1),
      contentLength: remote.length,
    })
    const partialID = ctx.service.codec.encode({
      digest: new Uint8Array(32).fill(2),
      contentLength: partial.length,
    })
    await ctx.store.insertEntry(
      { blobID: remoteID, contentLength: 10, chunkSize: 4, state: 'remote-only', createdAt: 5 },
      [],
    )
    await ctx.store.insertEntry(
      { blobID: partialID, contentLength: 10, chunkSize: 4, state: 'remote-only', createdAt: 5 },
      [],
    )
    await ctx.store.beginTransfer({
      blobID: partialID,
      chunkSize: 4,
      chunks: [],
      stagingID: 'stg-p',
    })
    await expect(ctx.service.createReadStream(remoteID)).rejects.toThrow(BlobNotFoundError)
    await expect(ctx.service.createReadStream(partialID)).rejects.toThrow(BlobNotFoundError)
    await expect(
      ctx.service.createReadStream(
        ctx.service.codec.encode({ digest: new Uint8Array(32), contentLength: 1 }),
      ),
    ).rejects.toThrow(BlobNotFoundError)
    expect(await ctx.service.has(remoteID)).toBe(false)
    expect(await ctx.service.has(partialID)).toBe(false)
  })
})
