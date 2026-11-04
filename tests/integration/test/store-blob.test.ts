import { HozonDB } from '@hozon/db'
import type {
  BlobChunkInput,
  BlobEntryInput,
  BlobSessionInput,
  BlobStoreAPI,
} from '@hozon/store-blob'
import { blobStoreDefinition, getBlobStore, withBlobLocks } from '@hozon/store-blob'
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

function session(input: BlobEntryInput, chunks: Array<BlobChunkInput>): BlobSessionInput {
  return {
    blobID: input.blobID,
    owner: 'owner-a',
    stagingID: 'stg-1',
    contentLength: input.contentLength,
    chunkSize: 4,
    contentType: input.contentType ?? null,
    encrypted: input.encrypted ?? false,
    keyID: input.keyID ?? null,
    createdAt: 1,
    updatedAt: 1,
    chunks,
  }
}

function bytes(digests: Array<Uint8Array>): Array<Array<number>> {
  return digests.map((digest) => Array.from(digest))
}

describe.each(backends())('$name', (backend) => {
  const databases: Array<HozonDB> = []
  const openDatabase = async (tablePrefix?: string): Promise<HozonDB> => {
    const db = new HozonDB({ adapter: await backend.createAdapter(), tablePrefix })
    databases.push(db)
    db.register(blobStoreDefinition)
    return db
  }
  const openStore = async (tablePrefix?: string): Promise<BlobStoreAPI> => {
    return getBlobStore(await openDatabase(tablePrefix))
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

  test('session lifecycle promotes complete chunks and clears progress', async () => {
    const db = await openDatabase()
    const input = entry({ state: 'remote-only', chunkSize: 0 })
    const chunks = manifest(3)
    await withBlobLocks(db, [input.blobID], async (tx) => {
      const store = await getBlobStore(tx)
      await store.insertEntry(input, [])
      expect(await store.getSession(input.blobID, 'owner-a')).toBeNull()
      await store.putSession(session(input, [...chunks].reverse()))
      expect(await store.getEntry(input.blobID)).toEqual(input)
      expect((await store.getSession(input.blobID, 'owner-a'))?.presentChunks).toEqual([])
      expect(
        bytes((await store.getSession(input.blobID, 'owner-a'))?.chunks.map((c) => c.digest) ?? []),
      ).toEqual(bytes(chunks.map((chunk) => chunk.digest)))
      expect(await store.getChunkDigests(input.blobID)).toEqual([])
      await store.markSessionChunk(input.blobID, 'owner-a', 1)
      await store.markSessionChunk(input.blobID, 'owner-a', 1)
      expect((await store.getSession(input.blobID, 'owner-a'))?.presentChunks).toEqual([1])
      // Completion rejects missing chunks at the service layer; the store retains progress.
      expect(
        (await store.getSession(input.blobID, 'owner-a'))?.chunks
          .filter((chunk) => !chunk.present)
          .map((chunk) => chunk.index),
      ).toEqual([0, 2])
      expect((await store.getEntry(input.blobID))?.state).toBe('remote-only')
      await store.touchSession(input.blobID, 'owner-a')
      expect((await store.getSession(input.blobID, 'owner-a'))?.presentChunks).toEqual([1])
      expect((await store.getSession(input.blobID, 'owner-a'))?.updatedAt).toBeGreaterThan(1)
      await store.markSessionChunk(input.blobID, 'owner-a', 2)
      await store.markSessionChunk(input.blobID, 'owner-a', 0)
      expect((await store.getSession(input.blobID, 'owner-a'))?.presentChunks).toEqual([0, 1, 2])
      const { state: _state, ...local } = input
      await store.promoteEntry({ ...local, chunkSize: 4 }, chunks)
      expect(await store.getEntry(input.blobID)).toEqual({ ...input, chunkSize: 4, state: 'local' })
      expect(await store.getSession(input.blobID, 'owner-a')).toBeNull()
      expect((await store.listSessions({ blobID: input.blobID, limit: 10 })).sessions).toEqual([])
      expect(bytes(await store.getChunkDigests(input.blobID))).toEqual(
        bytes(chunks.map((chunk) => chunk.digest)),
      )
    })
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

  test('promoteEntry replaces an entry with an active session atomically', async () => {
    const db = await openDatabase()
    await withBlobLocks(db, ['blob-1', 'blob-2'], async (tx) => {
      const store = await getBlobStore(tx)
      const remote = entry({ state: 'remote-only', pinned: true, createdAt: 5 })
      await store.insertEntry(remote, [])
      await store.putSession(session(remote, manifest(3)))
      await store.markSessionChunk('blob-1', 'owner-a', 0)
      const { state: _state, ...input } = entry({ chunkSize: 6, createdAt: 99, pinned: false })
      await store.promoteEntry(input, manifest(2))
      expect(await store.getEntry('blob-1')).toMatchObject({
        state: 'local',
        chunkSize: 6,
        pinned: true,
        createdAt: 5,
      })
      expect(await store.getChunkDigests('blob-1')).toHaveLength(2)
      expect(await store.getSession('blob-1', 'owner-a')).toBeNull()
      const { state: _s, ...fresh } = entry({ blobID: 'blob-2' })
      await store.promoteEntry(fresh, manifest(3))
      expect((await store.getEntry('blob-2'))?.state).toBe('local')
      expect(await store.getChunkDigests('blob-2')).toHaveLength(3)
    })
  })

  test('deleting sessions leaves the entry remote-only', async () => {
    const db = await openDatabase()
    await withBlobLocks(db, ['blob-1', 'missing'], async (tx) => {
      const store = await getBlobStore(tx)
      const input = entry({ state: 'remote-only' })
      await store.insertEntry(input, [])
      await store.putSession(session(input, manifest(3)))
      await store.markSessionChunk('blob-1', 'owner-a', 0)
      await store.deleteSession('blob-1', 'owner-a')
      expect((await store.getEntry('blob-1'))?.state).toBe('remote-only')
      expect(await store.getChunkDigests('blob-1')).toEqual([])
      expect(await store.getSession('blob-1', 'owner-a')).toBeNull()
      await store.deleteSession('missing', 'owner-a')
      await store.putSession(session(input, manifest(3)))
      await store.deleteSessions('blob-1')
      expect((await store.listSessions({ blobID: 'blob-1', limit: 10 })).sessions).toEqual([])
      expect((await store.getEntry('blob-1'))?.state).toBe('remote-only')
      expect(await store.getChunkDigests('blob-1')).toEqual([])
      await store.deleteSessions('missing')
    })
  })

  test('custom table prefix supports an entry round trip', async () => {
    const store = await openStore('custom')
    const input = entry()
    await store.insertEntry(input, [])
    expect(await store.getEntry(input.blobID)).toEqual(input)
  })
})
