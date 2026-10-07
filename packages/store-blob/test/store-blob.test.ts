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
  const input = entry({ encrypted: true, keyID: 'k1', pinned: false })
  await store.insertEntry(input, [])
  expect(await store.getEntry('b1')).toEqual(input)
  expect(BLOB_STORE).toBe('blob')
  expect(await store.getEntry('missing')).toBeNull()
})
test('optional metadata defaults to false and null', async () => {
  await store.insertEntry(entry(), [])
  expect(await store.getEntry('b1')).toEqual({
    ...entry(),
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
      await store.beginTransfer('b1', 4, chunks)
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
  await store.beginTransfer('b1', 4, manifest())
  await store.recordTransferChunk('b1', 1)
  await store.deleteEntry('b1')
  expect(await store.getEntry('b1')).toBeNull()
  expect(await store.getChunkDigests('b1')).toEqual([])
  expect(await store.getPresentChunkIndexes('b1')).toEqual([])
})
test('transfer lifecycle', async () => {
  await store.insertEntry(entry({ state: 'remote-only', chunkSize: 0 }), [])
  await store.beginTransfer('b1', 4, manifest())
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
  await store.beginTransfer('b1', 4, manifest(2))
  await store.recordTransferChunk('b1', 0)
  await expect(store.finalizeTransfer('b1')).rejects.toThrow(
    'Cannot finalize transfer b1: 1 chunk(s) missing',
  )
  expect((await store.getEntry('b1'))?.state).toBe('partial')
  expect(await store.getPresentChunkIndexes('b1')).toEqual([0])
})
test('beginTransfer and finalizeTransfer throw for an unknown blob', async () => {
  await expect(store.beginTransfer('nope', 4, manifest())).rejects.toThrow(
    'Blob entry nope not found',
  )
  await expect(store.finalizeTransfer('nope')).rejects.toThrow('Blob entry nope not found')
  expect(await store.getChunkDigests('nope')).toEqual([])
})
test('beginTransfer is atomic', async () => {
  await expect(store.beginTransfer('nope', 4, manifest())).rejects.toThrow(
    'Blob entry nope not found',
  )
  expect(adapter.database.prepare('SELECT * FROM hozon_blob_chunks').all()).toEqual([])
})
test('uses a custom table prefix', async () => {
  await db.close()
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter, tablePrefix: 'kubun' })
  db.register(blobStoreDefinition)
  store = await getBlobStore(db)
  await store.insertEntry(entry({ state: 'remote-only' }), [])
  await store.beginTransfer('b1', 4, manifest(1))
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
  await store.beginTransfer('b2', 4, manifest(600))
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
  await expect(store.beginTransfer('b1', 4, manifest(200))).rejects.toThrow('chunk failed')
  expect(await store.getEntry('b1')).toMatchObject({ state: 'remote-only', chunkSize: 0 })
  expect(await store.getChunkDigests('b1')).toEqual([])
})
test('store mutations reuse the provider transaction and roll back together', async () => {
  await db.withTransaction(async (tx) => {
    const scoped = await getBlobStore(tx)
    await scoped.insertEntry(entry({ state: 'remote-only' }), [])
    await scoped.beginTransfer('b1', 4, manifest(1))
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
  await store.beginTransfer('b1', 4, manifest(2))
  await store.recordTransferChunk('b1', 0)
  await store.recordTransferChunk('b1', 1)
  await expect(
    store.beginTransfer('b1', 8, [{ index: 0, digest: new Uint8Array([99]) }]),
  ).rejects.toThrow('Cannot change chunk size for blob b1: manifest already exists')
  expect(await store.getEntry('b1')).toMatchObject({ state: 'partial', chunkSize: 4 })
  expect(bytes(await store.getChunkDigests('b1'))).toEqual([
    [0, 0, 0, 255],
    [1, 0, 0, 255],
  ])
  expect(await store.getPresentChunkIndexes('b1')).toEqual([0, 1])
  await store.beginTransfer('b1', 4, manifest(2))
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
  await store.beginTransfer('b1', 4, manifest(1))
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
