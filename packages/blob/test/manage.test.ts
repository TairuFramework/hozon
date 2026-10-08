import type { BlobBackend } from '@hozon/blob-backend'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { BlobNotFoundError } from '../src/index.js'
import {
  backendFactories,
  bytesOf,
  createTestService,
  listStaging,
  sourceOf,
  type TestService,
} from './helpers.js'

describe.each(backendFactories)('manage ($name)', (factory) => {
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

  test('setPinned toggles and rejects unknown IDs', async () => {
    const { entry } = await ctx.service.write(sourceOf(bytesOf(10)).stream)
    await ctx.service.setPinned(entry.blobID, true)
    expect((await ctx.service.get(entry.blobID))?.pinned).toBe(true)
    await ctx.service.setPinned(entry.blobID, false)
    expect((await ctx.service.get(entry.blobID))?.pinned).toBe(false)
    const unknown = ctx.service.codec.encode({ digest: new Uint8Array(32), contentLength: 1 })
    await expect(ctx.service.setPinned(unknown, true)).rejects.toThrow(BlobNotFoundError)
  })

  test('delete removes row, manifest and bytes', async () => {
    const { entry } = await ctx.service.write(sourceOf(bytesOf(5000)).stream)
    const id = entry.blobID
    expect(await ctx.service.delete(id)).toBe(true)
    expect(await ctx.store.getEntry(id)).toBeNull()
    expect(await ctx.store.getChunkDigests(id)).toEqual([])
    expect(await backend.has(id)).toBe(false)
    expect(await ctx.service.delete(id)).toBe(false)
  })

  test('delete aborts the staging area of a partial entry', async () => {
    const id = ctx.service.codec.encode({ digest: new Uint8Array(32).fill(3), contentLength: 10 })
    await ctx.store.insertEntry(
      { blobID: id, contentLength: 10, chunkSize: 4, state: 'remote-only', createdAt: 5 },
      [],
    )
    await ctx.store.beginTransfer(id, 4, [], 'stg-del')
    await backend.writeChunk('stg-del', 0, bytesOf(4))
    expect(await listStaging(backend)).toEqual(['stg-del'])
    expect(await ctx.service.delete(id)).toBe(true)
    expect(await ctx.store.getEntry(id)).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  test('concurrent write and delete leave row present iff bytes present', async () => {
    const data = bytesOf(5000)
    const { entry } = await ctx.service.write(sourceOf(data).stream)
    const id = entry.blobID
    for (let i = 0; i < 20; i++) {
      await Promise.all([ctx.service.write(sourceOf(data, 500).stream), ctx.service.delete(id)])
      const row = (await ctx.store.getEntry(id)) !== null
      expect(row).toBe(await backend.has(id))
    }
  })
})
