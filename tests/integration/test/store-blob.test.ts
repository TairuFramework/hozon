import { HozonDB } from '@hozon/db'
import type { BlobChunkInput, BlobEntryInput, BlobStoreAPI } from '@hozon/store-blob'
import { blobStoreDefinition, getBlobStore } from '@hozon/store-blob'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'

function entry(overrides: Partial<BlobEntryInput> = {}): BlobEntryInput {
  return {
    blobID: 'blob-1',
    contentLength: 12,
    encrypted: true,
    keyID: 'key-1',
    chunkSize: 4,
    state: 'local',
    pinned: true,
    createdAt: Date.now(),
    contentType: null,
    ...overrides,
  }
}

function manifest(length: number): Array<BlobChunkInput> {
  return Array.from({ length }, (_, index) => ({
    index,
    digest: new Uint8Array([index % 256, Math.floor(index / 256), 0, 128, 255]),
  }))
}

function bytes(digests: Array<Uint8Array>): Array<Array<number>> {
  return digests.map((digest) => Array.from(digest))
}

describe.each(backends())('$name', (backend) => {
  const databases: Array<HozonDB> = []
  const openStore = async (tablePrefix?: string): Promise<BlobStoreAPI> => {
    const db = new HozonDB({ adapter: await backend.createAdapter(), tablePrefix })
    databases.push(db)
    db.register(blobStoreDefinition)
    return getBlobStore(db)
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  test('entry round trip preserves bigint columns as numbers', async () => {
    const store = await openStore()
    const input = entry({ contentLength: 5 * 1024 ** 3, createdAt: Date.now() })
    await store.insertEntry(input, [])
    const result = await store.getEntry(input.blobID)
    expect(result).toEqual(input)
    expect(typeof result?.contentLength).toBe('number')
    expect(typeof result?.createdAt).toBe('number')
  })

  test('600-chunk manifest preserves every digest byte in index order', async () => {
    const store = await openStore()
    const input = entry({ contentLength: 600 * 4 })
    const chunks = manifest(600)
    await store.insertEntry(input, [...chunks].reverse())
    const digests = await store.getChunkDigests(input.blobID)
    expect(digests).toHaveLength(600)
    expect(bytes(digests)).toEqual(bytes(chunks.map((chunk) => chunk.digest)))
  })

  test('transfer lifecycle finalizes complete chunks and clears progress', async () => {
    const store = await openStore()
    const input = entry({ state: 'remote-only', chunkSize: 0 })
    const chunks = manifest(3)
    await store.insertEntry(input, [])
    expect(await store.getPresentChunkIndexes(input.blobID)).toEqual([])
    await store.beginTransfer(input.blobID, 4, [...chunks].reverse(), 'stg-1')
    expect(await store.getEntry(input.blobID)).toEqual({ ...input, chunkSize: 4, state: 'partial' })
    expect(bytes(await store.getChunkDigests(input.blobID))).toEqual(
      bytes(chunks.map((chunk) => chunk.digest)),
    )
    await store.recordTransferChunk(input.blobID, 1)
    await store.recordTransferChunk(input.blobID, 1)
    expect(await store.getPresentChunkIndexes(input.blobID)).toEqual([1])
    await expect(store.finalizeTransfer(input.blobID)).rejects.toThrow(/chunk\(s\) missing/)
    expect((await store.getEntry(input.blobID))?.state).toBe('partial')
    expect(await store.getPresentChunkIndexes(input.blobID)).toEqual([1])
    await store.recordTransferChunk(input.blobID, 2)
    await store.recordTransferChunk(input.blobID, 0)
    expect(await store.getPresentChunkIndexes(input.blobID)).toEqual([0, 1, 2])
    await store.finalizeTransfer(input.blobID)
    expect(await store.getEntry(input.blobID)).toEqual({ ...input, chunkSize: 4, state: 'local' })
    expect(await store.getPresentChunkIndexes(input.blobID)).toEqual([])
    expect(bytes(await store.getChunkDigests(input.blobID))).toEqual(
      bytes(chunks.map((chunk) => chunk.digest)),
    )
  })

  test('listEntries pages by (createdAt, blobID)', async () => {
    const store = await openStore()
    for (const id of ['b3', 'b1', 'b5', 'b2', 'b4']) {
      await store.insertEntry(entry({ blobID: id, createdAt: 1000 }), [])
    }
    const first = await store.listEntries({ limit: 2 })
    expect(first.entries.map((e) => e.blobID)).toEqual(['b1', 'b2'])
    const second = await store.listEntries({ limit: 2, cursor: first.nextCursor as string })
    expect(second.entries.map((e) => e.blobID)).toEqual(['b3', 'b4'])
    const third = await store.listEntries({ limit: 2, cursor: second.nextCursor as string })
    expect(third.entries.map((e) => e.blobID)).toEqual(['b5'])
    expect(third.nextCursor).toBeNull()
    await expect(store.listEntries({ limit: 2, cursor: 'not-a-cursor!' })).rejects.toThrow()
    await expect(store.listEntries({ limit: 0 })).rejects.toThrow()
  })

  test('promoteEntry replaces a partial entry atomically', async () => {
    const store = await openStore()
    await store.insertEntry(entry({ state: 'remote-only', pinned: true, createdAt: 5 }), [])
    await store.beginTransfer('blob-1', 4, manifest(3), 'stg-1')
    await store.recordTransferChunk('blob-1', 0)
    const { state: _state, ...input } = entry({ chunkSize: 6, createdAt: 99, pinned: false })
    await store.promoteEntry(input, manifest(2))
    expect(await store.getEntry('blob-1')).toMatchObject({
      state: 'local',
      chunkSize: 6,
      pinned: true,
      createdAt: 5,
    })
    expect(await store.getChunkDigests('blob-1')).toHaveLength(2)
    expect(await store.getTransfer('blob-1')).toBeNull()
    const { state: _s, ...fresh } = entry({ blobID: 'blob-2' })
    await store.promoteEntry(fresh, manifest(3))
    expect((await store.getEntry('blob-2'))?.state).toBe('local')
    expect(await store.getChunkDigests('blob-2')).toHaveLength(3)
  })

  test('resetTransfer returns a partial entry to remote-only', async () => {
    const store = await openStore()
    await store.insertEntry(entry({ state: 'remote-only' }), [])
    await store.beginTransfer('blob-1', 4, manifest(3), 'stg-1')
    await store.recordTransferChunk('blob-1', 0)
    await store.resetTransfer('blob-1')
    expect((await store.getEntry('blob-1'))?.state).toBe('remote-only')
    expect(await store.getChunkDigests('blob-1')).toEqual([])
    expect(await store.getTransfer('blob-1')).toBeNull()
    await store.resetTransfer('missing')
  })

  test('custom kubun table prefix supports an entry round trip', async () => {
    const store = await openStore('kubun')
    const input = entry()
    await store.insertEntry(input, [])
    expect(await store.getEntry(input.blobID)).toEqual(input)
  })
})
