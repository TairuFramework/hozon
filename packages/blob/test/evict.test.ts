import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  BlobNotFoundError,
  BlobNotLocalError,
  BlobPinnedError,
  createBlobService,
  InvalidManifestError,
} from '../src/index.js'
import { gatedBackend } from './gated-backend.js'
import { bytesOf, createTestService, digestOf, sourceOf } from './helpers.js'

let ctx: Awaited<ReturnType<typeof createTestService>>
const body = bytesOf(20)
beforeEach(async () => {
  ctx = await createTestService({ logger: { error: vi.fn() } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.db.close()
})
const write = () => ctx.service.write({ stream: sourceOf(body).stream, contentType: 'text/plain' })

test('eviction keeps metadata, refs and verified digests, while reads report remote', async () => {
  const { entry } = await write()
  const id = entry.blobID
  const digests = await ctx.store.getChunkDigests(id)
  await ctx.service.addRefs([{ blobID: id, kind: 'doc', key: 'owner-a' }])
  expect(await ctx.service.evict(id)).toBe(true)
  expect(await ctx.service.get(id)).toEqual({ ...entry, state: 'remote' })
  expect(await ctx.store.getChunkDigests(id)).toEqual(digests)
  expect(await ctx.service.listRefs(id)).toHaveLength(1)
  expect(await ctx.service.has(id)).toBe(false)
  expect(await ctx.service.getChunkDigests(id)).toEqual([])
  expect(await ctx.backend.has(id)).toBe(false)
  const read = ctx.service.createReadStream(id)
  await expect(read).rejects.toBeInstanceOf(BlobNotLocalError)
  await expect(read).rejects.toBeInstanceOf(BlobNotFoundError)
  await expect(read).rejects.toMatchObject({ state: 'remote' })
  expect(await ctx.service.evict(id)).toBe(false)
  await write()
  expect(await ctx.service.get(id)).toEqual(entry)
})

test('pin prevents eviction and fetch re-population preserves metadata and pin', async () => {
  const { entry } = await write()
  const id = entry.blobID
  await ctx.service.setPinned(id, true)
  await expect(ctx.service.evict(id)).rejects.toBeInstanceOf(BlobPinnedError)
  expect(await ctx.backend.has(id)).toBe(true)
  await ctx.service.setPinned(id, false)
  await ctx.service.evict(id)
  await ctx.service.setPinned(id, true)
  await ctx.service.beginFetch(id, {
    contentLength: body.length,
    chunkSize: entry.chunkSize,
    chunks: [digestOf(body)],
  })
  expect((await ctx.service.get(id))?.state).toBe('remote')
  await ctx.service.stageChunk({ id, index: 0, bytes: body })
  await ctx.service.completeFetch(id)
  expect(await ctx.service.get(id)).toEqual({ ...entry, pinned: true })
  expect(await ctx.backend.has(id)).toBe(true)
})

test('remote manifests with unequal digests or chunk size fail before session creation', async () => {
  const { entry } = await write()
  const id = entry.blobID
  await ctx.service.evict(id)
  for (const manifest of [
    { contentLength: body.length, chunkSize: entry.chunkSize, chunks: [digestOf(bytesOf(20, 1))] },
    { contentLength: body.length, chunkSize: entry.chunkSize * 2, chunks: [digestOf(body)] },
  ]) {
    await expect(ctx.service.beginFetch(id, manifest)).rejects.toBeInstanceOf(InvalidManifestError)
    expect(await ctx.store.getTransfer(id)).toBeNull()
    expect(await ctx.service.get(id)).toEqual({ ...entry, state: 'remote' })
  }
})

test('a pruned remote fetch retains verified digests and remote state', async () => {
  const { entry } = await write()
  const id = entry.blobID
  await ctx.service.evict(id)
  await ctx.service.beginFetch(id, {
    contentLength: body.length,
    chunkSize: entry.chunkSize,
    chunks: [digestOf(body)],
  })
  await ctx.service.stageChunk({ id, index: 0, bytes: body })
  await ctx.service.pruneStaging(new Date(Date.now() + 1000))
  expect(await ctx.service.get(id)).toEqual({ ...entry, state: 'remote' })
  expect(await ctx.store.getChunkDigests(id)).toEqual([digestOf(body)])
})

test('empty remote manifests still require the stored chunk size across service configurations', async () => {
  const { entry } = await ctx.service.write({ stream: sourceOf(new Uint8Array()).stream })
  const id = entry.blobID
  await ctx.service.evict(id)
  await expect(
    ctx.service.beginFetch(id, { contentLength: 0, chunkSize: entry.chunkSize * 2, chunks: [] }),
  ).rejects.toBeInstanceOf(InvalidManifestError)
  expect(await ctx.store.getTransfer(id)).toBeNull()
  const other = createBlobService({
    db: ctx.db,
    backend: ctx.backend,
    chunkSize: entry.chunkSize * 2,
  })
  await other.beginFetch(id, { contentLength: 0, chunkSize: entry.chunkSize, chunks: [] })
  await other.completeFetch(id)
  expect(await other.get(id)).toEqual(entry)
})

test('remote collection issues no backend deletion', async () => {
  const { entry } = await write()
  await ctx.service.evict(entry.blobID)
  const remove = vi.spyOn(ctx.backend, 'delete')
  expect((await ctx.service.collect({ releasedBefore: new Date(Date.now() + 1000) })).deleted).toBe(
    1,
  )
  expect(remove).not.toHaveBeenCalled()
})

test('caller eviction rolls back atomically and defers byte deletion until commit', async () => {
  const { entry } = await write()
  const id = entry.blobID
  await expect(
    ctx.db.withTransaction(async (tx) => {
      expect(await ctx.service.using(tx).evict(id)).toBe(true)
      expect(await ctx.backend.has(id)).toBe(true)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await ctx.service.get(id)).toEqual(entry)
  expect(await ctx.store.listByteDeletions()).toEqual([])
  await ctx.db.withTransaction(async (tx) => {
    await ctx.service.using(tx).evict(id)
    expect(await ctx.backend.has(id)).toBe(true)
  })
  await ctx.service.drainByteDeletions()
  expect(await ctx.backend.has(id)).toBe(false)
})

test.each(['write', 'fetch'] as const)(
  'a %s waiting behind eviction republishes local bytes',
  async (operation) => {
    await ctx.db.close()
    const gated = gatedBackend()
    ctx = await createTestService({ backend: gated.backend })
    const { entry } = await write()
    const id = entry.blobID
    const gate = gated.park('delete')
    const evicting = ctx.service.evict(id)
    await gate.entered
    const publishing =
      operation === 'write'
        ? write()
        : (async () => {
            await ctx.service.beginFetch(id, {
              contentLength: body.length,
              chunkSize: entry.chunkSize,
              chunks: [digestOf(body)],
            })
            await ctx.service.stageChunk({ id, index: 0, bytes: body })
            return await ctx.service.completeFetch(id)
          })()
    gate.release()
    await Promise.all([evicting, publishing])
    expect(await ctx.service.has(id)).toBe(true)
    expect(await ctx.backend.has(id)).toBe(true)
  },
)
