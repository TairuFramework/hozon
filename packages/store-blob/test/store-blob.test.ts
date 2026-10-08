import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { blobStoreDefinition } from '../src/definition.js'
import { BLOB_STORE, getBlobStore } from '../src/index.js'
import type { BlobChunkInput, BlobEntryInput, BlobStoreAPI } from '../src/types.js'

let db: HozonDB
let adapter: NodeSQLiteAdapter
let store: BlobStoreAPI
beforeEach(async () => {
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter })
  db.register(blobStoreDefinition)
  store = await getBlobStore(db)
})
afterEach(async () => {
  await db.close()
})
function entry(overrides: Partial<BlobEntryInput> = {}): BlobEntryInput {
  return {
    blobID: 'b1',
    contentLength: 12,
    chunkSize: 4,
    state: 'local',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}
function manifest(length = 3): Array<BlobChunkInput> {
  return Array.from({ length }, (_, index) => ({
    index,
    digest: new Uint8Array([index % 256, Math.floor(index / 256), 0, 255]),
  }))
}
function bytes(digests: Array<Uint8Array>): Array<Array<number>> {
  return digests.map((digest) => Array.from(digest))
}

test('insertEntry then getEntry returns the mapped entry', async () => {
  const input = entry({ encrypted: true, keyID: 'k1', pinned: false, contentType: 'text/plain' })
  await store.insertEntry(input, [])
  expect(await store.getEntry('b1')).toEqual(input)
  expect(BLOB_STORE).toBe('blob')
  expect(await store.getEntry('missing')).toBeNull()
})
test('optional metadata defaults to false and null', async () => {
  await store.insertEntry(entry(), [])
  expect(await store.getEntry('b1')).toEqual({
    ...entry(),
    contentType: null,
    encrypted: false,
    keyID: null,
    pinned: false,
  })
})
test('insertEntry is idempotent on blobID', async () => {
  await store.insertEntry(entry(), manifest())
  const original = await store.getEntry('b1')
  await store.insertEntry(
    entry({ contentLength: 999, chunkSize: 0, state: 'remote-only', createdAt: 2, pinned: true }),
    [{ index: 0, digest: new Uint8Array([99]) }],
  )
  expect(await store.getEntry('b1')).toEqual(original)
  expect(bytes(await store.getChunkDigests('b1'))).toEqual(bytes(manifest().map((c) => c.digest)))
})
test('getChunkDigests returns digests ordered by index', async () => {
  await store.insertEntry(entry(), manifest().reverse())
  expect(bytes(await store.getChunkDigests('b1'))).toEqual(bytes(manifest().map((c) => c.digest)))
})
test.each(['insertEntry', 'beginTransfer'] as const)(
  '%s preserves existing manifest digests while adding missing chunks',
  async (method) => {
    await store.insertEntry(entry(), [{ index: 0, digest: new Uint8Array([0, 255]) }])
    const chunks = [
      { index: 0, digest: new Uint8Array([99]) },
      { index: 1, digest: new Uint8Array([128, 0]) },
    ]
    if (method === 'insertEntry') {
      await store.insertEntry(entry(), chunks)
    } else {
      await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: chunks, stagingID: 'stg-1' })
    }
    expect(bytes(await store.getChunkDigests('b1'))).toEqual([
      [0, 255],
      [128, 0],
    ])
  },
)
test('stores a manifest of 600 chunks', async () => {
  const chunks = manifest(600)
  await store.insertEntry(entry(), chunks)
  const digests = await store.getChunkDigests('b1')
  expect(digests).toHaveLength(600)
  expect(bytes(digests)).toEqual(bytes(chunks.map((c) => c.digest)))
})
test('setPinned toggles pinned', async () => {
  await store.insertEntry(entry(), [])
  await store.setPinned('b1', true)
  expect((await store.getEntry('b1'))?.pinned).toBe(true)
  await store.setPinned('b1', false)
  expect((await store.getEntry('b1'))?.pinned).toBe(false)
})
test('deleteEntry removes entry, chunks, and transfer rows', async () => {
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 1)
  await store.deleteEntry('b1')
  expect(await store.getEntry('b1')).toBeNull()
  expect(await store.getChunkDigests('b1')).toEqual([])
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
})
test('transfer lifecycle', async () => {
  await store.insertEntry(entry({ state: 'remote-only', chunkSize: 0 }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(), stagingID: 'stg-1' })
  expect(await store.getEntry('b1')).toMatchObject({ state: 'partial', chunkSize: 4 })
  await store.recordTransferChunk('b1', 1)
  await store.recordTransferChunk('b1', 1)
  expect(await store.getPresentChunkIndexes('b1')).toEqual([1])
  await store.recordTransferChunk('b1', 2)
  await store.recordTransferChunk('b1', 0)
  expect(await store.getPresentChunkIndexes('b1')).toEqual([0, 1, 2])
  await store.finalizeTransfer('b1')
  expect((await store.getEntry('b1'))?.state).toBe('local')
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
  expect(bytes(await store.getChunkDigests('b1'))).toEqual(bytes(manifest().map((c) => c.digest)))
})
test('finalizeTransfer throws when chunks are missing', async () => {
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(2), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 0)
  await expect(store.finalizeTransfer('b1')).rejects.toThrow(
    'Cannot finalize transfer b1: 1 chunk(s) missing',
  )
  expect((await store.getEntry('b1'))?.state).toBe('partial')
  expect(await store.getPresentChunkIndexes('b1')).toEqual([0])
})
test('beginTransfer and finalizeTransfer throw for an unknown blob', async () => {
  await expect(
    store.beginTransfer({ blobID: 'nope', chunkSize: 4, chunks: manifest(), stagingID: 'stg-1' }),
  ).rejects.toThrow('Blob entry nope not found')
  await expect(store.finalizeTransfer('nope')).rejects.toThrow('Blob entry nope not found')
  expect(await store.getChunkDigests('nope')).toEqual([])
})
test('beginTransfer is atomic', async () => {
  await expect(
    store.beginTransfer({ blobID: 'nope', chunkSize: 4, chunks: manifest(), stagingID: 'stg-1' }),
  ).rejects.toThrow('Blob entry nope not found')
  expect(adapter.database.prepare('SELECT * FROM hozon_blob_chunks').all()).toEqual([])
})
test('uses a custom table prefix', async () => {
  await db.close()
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter, tablePrefix: 'kubun' })
  db.register(blobStoreDefinition)
  store = await getBlobStore(db)
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(1), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 0)
  await store.finalizeTransfer('b1')
  expect((await store.getEntry('b1'))?.state).toBe('local')
  const names = adapter.database
    .prepare('SELECT name FROM sqlite_master ORDER BY name')
    .all()
    .map((row) => row.name)
  expect(names).toEqual(
    expect.arrayContaining(['kubun_blob_entries', 'kubun_blob_chunks', 'kubun_blob_transfers']),
  )
  expect(names.some((name) => String(name).startsWith('kubun_kubun_'))).toBe(false)
  await store.deleteEntry('b1')
  expect(await store.getEntry('b1')).toBeNull()
})
test('every statement stays within 500 bound parameters', async () => {
  const prepare = vi.spyOn(adapter.database, 'prepare')
  await store.insertEntry(entry(), manifest(600))
  await store.insertEntry(entry({ blobID: 'b2', state: 'remote-only' }), [])
  await store.beginTransfer({
    blobID: 'b2',
    chunkSize: 4,
    chunks: manifest(600),
    stagingID: 'stg-1',
  })
  const counts = prepare.mock.calls.map(([sql]) => (sql.match(/\?/g) ?? []).length)
  expect(Math.max(...counts)).toBe(498)
  expect(counts.filter((count) => count === 498)).toHaveLength(6)
})
test('insertEntry rolls back its entry and earlier manifest batches on failure', async () => {
  adapter.database.exec(
    'CREATE TRIGGER fail_chunk BEFORE INSERT ON hozon_blob_chunks WHEN NEW."index" = 170 BEGIN SELECT RAISE(ABORT, \'chunk failed\'); END',
  )
  await expect(store.insertEntry(entry(), manifest(200))).rejects.toThrow('chunk failed')
  expect(await store.getEntry('b1')).toBeNull()
  expect(await store.getChunkDigests('b1')).toEqual([])
})
test('beginTransfer rolls back metadata and earlier manifest batches on failure', async () => {
  await store.insertEntry(entry({ state: 'remote-only', chunkSize: 0 }), [])
  adapter.database.exec(
    'CREATE TRIGGER fail_chunk BEFORE INSERT ON hozon_blob_chunks WHEN NEW."index" = 170 BEGIN SELECT RAISE(ABORT, \'chunk failed\'); END',
  )
  await expect(
    store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(200), stagingID: 'stg-1' }),
  ).rejects.toThrow('chunk failed')
  expect(await store.getEntry('b1')).toMatchObject({ state: 'remote-only', chunkSize: 0 })
  expect(await store.getChunkDigests('b1')).toEqual([])
})
test('store mutations reuse the provider transaction and roll back together', async () => {
  await db.withTransaction(async (tx) => {
    const scoped = await getBlobStore(tx)
    await scoped.insertEntry(entry({ state: 'remote-only' }), [])
    await scoped.beginTransfer({
      blobID: 'b1',
      chunkSize: 4,
      chunks: manifest(1),
      stagingID: 'stg-1',
    })
    await scoped.recordTransferChunk('b1', 0)
    await scoped.finalizeTransfer('b1')
  })
  await expect(
    db.withTransaction(async (tx) => {
      const scoped = await getBlobStore(tx)
      await scoped.deleteEntry('b1')
      await scoped.insertEntry(entry({ blobID: 'b2' }), manifest())
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect((await store.getEntry('b1'))?.state).toBe('local')
  expect(await store.getChunkDigests('b1')).toHaveLength(1)
  expect(await store.getEntry('b2')).toBeNull()
})

test('beginTransfer rejects changing chunk size with an existing manifest without changing progress', async () => {
  await store.insertEntry(entry({ state: 'remote-only', contentLength: 8, chunkSize: 0 }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(2), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 0)
  await store.recordTransferChunk('b1', 1)
  await expect(
    store.beginTransfer({
      blobID: 'b1',
      chunkSize: 8,
      chunks: [{ index: 0, digest: new Uint8Array([99]) }],
      stagingID: 'stg-1',
    }),
  ).rejects.toThrow('Cannot change chunk size for blob b1: manifest already exists')
  expect(await store.getEntry('b1')).toMatchObject({ state: 'partial', chunkSize: 4 })
  expect(bytes(await store.getChunkDigests('b1'))).toEqual([
    [0, 0, 0, 255],
    [1, 0, 0, 255],
  ])
  expect(await store.getPresentChunkIndexes('b1')).toEqual([0, 1])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(2), stagingID: 'stg-1' })
  expect(await store.getPresentChunkIndexes('b1')).toEqual([0, 1])
  await store.finalizeTransfer('b1')
  expect((await store.getEntry('b1'))?.state).toBe('local')
})

test('recordTransferChunk rejects an unknown blob without writing progress', async () => {
  await expect(store.recordTransferChunk('missing', 0)).rejects.toThrow(
    'Blob entry missing not found',
  )
  expect(await store.getPresentChunkIndexes('missing')).toEqual([])
})

test('recordTransferChunk rejects indexes absent from the manifest', async () => {
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await expect(store.recordTransferChunk('b1', 0)).rejects.toThrow(
    'Blob chunk b1 at index 0 not found',
  )
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(1), stagingID: 'stg-1' })
  await expect(store.recordTransferChunk('b1', 1)).rejects.toThrow(
    'Blob chunk b1 at index 1 not found',
  )
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
})

test('late transfer callbacks cannot recreate progress after deletion or reinsertion', async () => {
  await store.insertEntry(entry({ state: 'partial' }), manifest(1))
  await store.recordTransferChunk('b1', 0)
  await store.deleteEntry('b1')
  await expect(store.recordTransferChunk('b1', 0)).rejects.toThrow('Blob entry b1 not found')
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await expect(store.recordTransferChunk('b1', 0)).rejects.toThrow(
    'Blob chunk b1 at index 0 not found',
  )
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
})

test('foreign keys prevent orphan progress and cascade manifest deletion', async () => {
  expect(() =>
    adapter.database
      .prepare('INSERT INTO hozon_blob_transfers (blob_id, "index") VALUES (?, ?)')
      .run('missing', 0),
  ).toThrow()
  await store.insertEntry(entry(), manifest(1))
  await store.recordTransferChunk('b1', 0)
  adapter.database.prepare('DELETE FROM hozon_blob_entries WHERE blob_id = ?').run('b1')
  expect(await store.getChunkDigests('b1')).toEqual([])
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
})

test('contentType round-trips and defaults to null', async () => {
  await store.insertEntry(entry({ blobID: 'ct', contentType: 'image/png' }), [])
  await store.insertEntry(entry({ blobID: 'none' }), [])
  expect((await store.getEntry('ct'))?.contentType).toBe('image/png')
  expect((await store.getEntry('none'))?.contentType).toBeNull()
})

test('transfer sessions track staging ID and progress', async () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(1000)
    await store.insertEntry(entry({ state: 'remote-only' }), [])
    expect(await store.getTransfer('b1')).toBeNull()
    await store.beginTransfer({
      blobID: 'b1',
      chunkSize: 4,
      chunks: manifest(),
      stagingID: 'stg-1',
    })
    expect(await store.getTransfer('b1')).toEqual({
      stagingID: 'stg-1',
      updatedAt: 1000,
      presentChunks: [],
    })
    expect(await store.getTransferByStagingID('stg-1')).toEqual({ blobID: 'b1', updatedAt: 1000 })
    vi.setSystemTime(2000)
    await store.recordTransferChunk('b1', 1)
    expect(await store.getTransfer('b1')).toEqual({
      stagingID: 'stg-1',
      updatedAt: 2000,
      presentChunks: [1],
    })
    vi.setSystemTime(3000)
    await store.touchTransfer('b1')
    expect((await store.getTransfer('b1'))?.updatedAt).toBe(3000)
    await store.beginTransfer({
      blobID: 'b1',
      chunkSize: 4,
      chunks: manifest(),
      stagingID: 'stg-2',
    })
    expect(await store.getTransferByStagingID('stg-1')).toBeNull()
    expect(await store.getTransferByStagingID('stg-2')).toMatchObject({ blobID: 'b1' })
    expect(await store.getTransfer('b1')).toMatchObject({ stagingID: 'stg-2' })
    expect(await store.getTransferByStagingID('missing')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('finalizeTransfer and deleteEntry remove the session', async () => {
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(1), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 0)
  await store.finalizeTransfer('b1')
  expect(await store.getTransfer('b1')).toBeNull()
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(1), stagingID: 'stg-2' })
  await store.deleteEntry('b1')
  expect(await store.getTransfer('b1')).toBeNull()
  expect(await store.getTransferByStagingID('stg-2')).toBeNull()
})

test('beginTransfer with a new staging ID clears previous progress', async () => {
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 1)
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(), stagingID: 'stg-1' })
  expect((await store.getTransfer('b1'))?.presentChunks).toEqual([1])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(), stagingID: 'stg-2' })
  expect((await store.getTransfer('b1'))?.presentChunks).toEqual([])
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
})

test('listEntries pages by (createdAt, blobID) with an opaque cursor', async () => {
  for (const id of ['b3', 'b1', 'b5', 'b2', 'b4']) {
    await store.insertEntry(entry({ blobID: id }), [])
  }
  const first = await store.listEntries({ limit: 2 })
  expect(first.entries.map((e) => e.blobID)).toEqual(['b1', 'b2'])
  expect(first.nextCursor).not.toBeNull()
  const second = await store.listEntries({ limit: 2, cursor: first.nextCursor as string })
  expect(second.entries.map((e) => e.blobID)).toEqual(['b3', 'b4'])
  const third = await store.listEntries({ limit: 2, cursor: second.nextCursor as string })
  expect(third.entries.map((e) => e.blobID)).toEqual(['b5'])
  expect(third.nextCursor).toBeNull()
})
test('listEntries orders by createdAt first and rejects bad input', async () => {
  await store.insertEntry(entry({ blobID: 'a', createdAt: 20 }), [])
  await store.insertEntry(entry({ blobID: 'z', createdAt: 10 }), [])
  const result = await store.listEntries({ limit: 10 })
  expect(result.entries.map((e) => e.blobID)).toEqual(['z', 'a'])
  expect(result.nextCursor).toBeNull()
  await expect(store.listEntries({ limit: 2, cursor: 'not-a-cursor!' })).rejects.toThrow()
  await expect(store.listEntries({ limit: 0 })).rejects.toThrow()
  await expect(store.listEntries({ limit: 1001 })).rejects.toThrow()
})

test('promoteEntry inserts a local entry with manifest when absent', async () => {
  const { state: _state, ...input } = entry({ contentType: 'text/plain' })
  await store.promoteEntry(input, manifest())
  expect(await store.getEntry('b1')).toEqual({
    ...entry({ contentType: 'text/plain' }),
    encrypted: false,
    keyID: null,
    pinned: false,
  })
  expect(bytes(await store.getChunkDigests('b1'))).toEqual(bytes(manifest().map((c) => c.digest)))
})
test('promoteEntry replaces a partial entry and keeps pinned and createdAt', async () => {
  await store.insertEntry(entry({ state: 'remote-only', pinned: true, createdAt: 5 }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(3), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 0)
  const { state: _state, ...input } = entry({ chunkSize: 6, createdAt: 99, pinned: false })
  await store.promoteEntry(input, manifest(2))
  expect(await store.getEntry('b1')).toMatchObject({
    state: 'local',
    chunkSize: 6,
    pinned: true,
    createdAt: 5,
  })
  expect(await store.getChunkDigests('b1')).toHaveLength(2)
  expect(await store.getTransfer('b1')).toBeNull()
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
})
test('promoteEntry works on a remote-only stub with chunkSize 0', async () => {
  await store.insertEntry(entry({ state: 'remote-only', chunkSize: 0 }), [])
  const { state: _state, ...input } = entry()
  await store.promoteEntry(input, manifest())
  expect(await store.getEntry('b1')).toMatchObject({ state: 'local', chunkSize: 4 })
  expect(await store.getChunkDigests('b1')).toHaveLength(3)
})

test('resetTransfer returns a partial entry to remote-only', async () => {
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await store.beginTransfer({ blobID: 'b1', chunkSize: 4, chunks: manifest(), stagingID: 'stg-1' })
  await store.recordTransferChunk('b1', 0)
  await store.resetTransfer('b1')
  expect((await store.getEntry('b1'))?.state).toBe('remote-only')
  expect(await store.getChunkDigests('b1')).toEqual([])
  expect(await store.getTransfer('b1')).toBeNull()
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
  await store.resetTransfer('missing')
})

test('fillContentType sets a null content type only', async () => {
  await store.insertEntry(entry(), [])
  await store.fillContentType('b1', 'image/png')
  expect((await store.getEntry('b1'))?.contentType).toBe('image/png')
  await store.fillContentType('b1', 'text/plain')
  expect((await store.getEntry('b1'))?.contentType).toBe('image/png')
  await store.fillContentType('missing', 'text/plain')
  expect(await store.getEntry('missing')).toBeNull()
})
