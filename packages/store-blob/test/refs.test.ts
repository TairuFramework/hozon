import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { blobStoreDefinition, getBlobStore } from '../src/index.js'
import type { BlobStoreAPI } from '../src/types.js'

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
const entry = {
  blobID: 'blob-a',
  contentLength: 8,
  chunkSize: 4,
  state: 'local' as const,
  createdAt: 1,
}

test('refs precede entries, are idempotent, and page by holder and blob', async () => {
  await store.insertRefs([
    { blobID: 'blob-a', kind: 'doc', key: 'ab' },
    { blobID: 'blob-b', kind: 'doc', key: 'ab' },
    { blobID: 'blob-a', kind: 'doc', key: 'a' },
    { blobID: 'blob-a', kind: 'doc', key: 'abc' },
    { blobID: 'blob-a', kind: 'image', key: 'ab' },
  ])
  await store.insertRefs([{ blobID: 'blob-a', kind: 'doc', key: 'ab' }])
  expect(await store.getEntry('blob-a')).toBeNull()
  expect(await store.countRefs('blob-a')).toBe(4)
  expect(await store.listRefs('blob-a')).toHaveLength(4)
  const first = await store.findRefs({ kind: 'doc', keyPrefix: 'ab', limit: 2 })
  expect(first.refs.map((r) => [r.key, r.blobID])).toEqual([
    ['ab', 'blob-a'],
    ['ab', 'blob-b'],
  ])
  const last = await store.findRefs({
    kind: 'doc',
    keyPrefix: 'ab',
    limit: 2,
    cursor: first.nextCursor ?? undefined,
  })
  expect(last.refs.map((r) => r.key)).toEqual(['abc'])
  expect(last.nextCursor).toBeNull()
  expect(
    (await store.findRefs({ kind: 'doc', key: 'ab', blobID: 'blob-a', limit: 10 })).refs,
  ).toHaveLength(1)
  await expect(store.findRefs({ kind: 'doc', limit: 0 })).rejects.toThrow()
  await expect(store.findRefs({ kind: 'doc', limit: 10, cursor: 'bad' })).rejects.toThrow()
  expect(await store.deleteRefsByHolder({ kind: 'doc', keyPrefix: 'ab' })).toHaveLength(3)
  expect(await store.countRefs('blob-a')).toBe(2)
})

test('600 refs and release upserts never bind more than 500 parameters', async () => {
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const refs = Array.from({ length: 600 }, (_, i) => ({
    blobID: 'blob-a',
    kind: 'doc',
    key: String(i),
  }))
  await store.insertEntry(entry, [])
  await store.insertRefs(refs)
  expect(await store.countRefs('blob-a')).toBe(600)
  expect(await store.deleteRefs(refs)).toHaveLength(600)
  const insert = adapter.database.prepare(
    'INSERT INTO hozon_blob_entries (blob_id, content_length, chunk_size, state, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  for (let i = 0; i < 600; i++) insert.run(`blob-${i}`, 8, 4, 'local', 1)
  await store.upsertReleases(
    Array.from({ length: 600 }, (_, i) => `blob-${i}`),
    20,
  )
  expect(await store.listReleases({ releasedBefore: new Date(21), limit: 500 })).toHaveLength(500)
  expect(
    await store.listReleases({ releasedBefore: new Date(21), blobID: 'blob-599' }),
  ).toHaveLength(1)
  const counts = prepare.mock.calls.map(([sql]) => (sql.match(/\?/g) ?? []).length)
  expect(Math.max(...counts)).toBeLessThanOrEqual(500)
  expect(counts).toContain(500)
})

test('creation, promotion, unpin, and ended sessions refresh release rows', async () => {
  await store.insertEntry(entry, [])
  expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toHaveLength(1)
  await store.upsertReleases(['blob-a'], 10)
  expect(await store.listReleases({ releasedBefore: new Date(10) })).toEqual([])
  expect(await store.listReleases({ releasedBefore: new Date(11) })).toEqual([
    { blobID: 'blob-a', releasedAt: 10 },
  ])
  await store.setPinned('blob-a', false)
  expect(await store.listReleases({ releasedBefore: new Date(11) })).toEqual([])
  await store.deleteRelease('blob-a')
  expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toEqual([])
  await store.promoteEntry(entry, [])
  expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toHaveLength(1)
  await store.deleteRelease('blob-a')
  await store.resetTransfer('blob-a')
  expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toHaveLength(1)
  await store.deleteEntry('blob-a')
  expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toEqual([])
})

test('remote transfers retain verified layout and state when reset', async () => {
  const chunks = [
    { index: 0, digest: new Uint8Array([1]) },
    { index: 1, digest: new Uint8Array([2]) },
  ]
  await store.insertEntry(entry, chunks)
  await store.setState('blob-a', 'remote')
  await store.beginTransfer({ blobID: 'blob-a', chunkSize: 4, chunks, stagingID: 't-remote' })
  expect((await store.getEntry('blob-a'))?.state).toBe('remote')
  await store.recordTransferChunk('blob-a', 0)
  await store.resetTransfer('blob-a')
  expect((await store.getEntry('blob-a'))?.state).toBe('remote')
  expect(await store.getChunkDigests('blob-a')).toEqual(chunks.map((c) => c.digest))
})
