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

  test('custom kubun table prefix supports an entry round trip', async () => {
    const store = await openStore('kubun')
    const input = entry()
    await store.insertEntry(input, [])
    expect(await store.getEntry(input.blobID)).toEqual(input)
  })
})
