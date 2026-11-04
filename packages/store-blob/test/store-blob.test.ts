import { BatchLimitError, HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { blobStoreDefinition } from '../src/definition.js'
import { BLOB_STORE, getBlobStore, InvalidCursorError } from '../src/index.js'
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
test('preserves JSON-looking plain text columns', async () => {
  const input = entry({ encrypted: false, pinned: false, keyID: '[1,2]', contentType: '{"a":1}' })
  await store.insertEntry(input, [])
  expect(await store.getEntry(input.blobID)).toEqual(input)
  expect((await store.listEntries({ limit: 10 })).entries).toEqual([input])
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
test('insertEntry preserves existing digests while adding missing chunks', async () => {
  await store.insertEntry(entry(), [{ index: 0, digest: new Uint8Array([0, 255]) }])
  await store.insertEntry(entry(), [
    { index: 0, digest: new Uint8Array([99]) },
    { index: 1, digest: new Uint8Array([128, 0]) },
  ])
  expect(bytes(await store.getChunkDigests('b1'))).toEqual([
    [0, 255],
    [128, 0],
  ])
})
test('stores a manifest of 600 chunks', async () => {
  const chunks = manifest(600)
  await store.insertEntry(entry(), chunks)
  const digests = await store.getChunkDigests('b1')
  expect(digests).toHaveLength(600)
  expect(bytes(digests)).toEqual(bytes(chunks.map((c) => c.digest)))
})
test('insertEntry never binds more than 500 parameters per statement', async () => {
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const chunks = manifest(600)
  await store.insertEntry(entry(), chunks)
  const counts = prepare.mock.calls.map(([sql]) => (sql.match(/\?/g) ?? []).length)
  expect(counts.some((count) => count > 0)).toBe(true)
  expect(Math.max(...counts)).toBeLessThanOrEqual(500)
  expect(bytes(await store.getChunkDigests('b1'))).toEqual(bytes(chunks.map((c) => c.digest)))
})

test('caller rollback restores a deleted entry and manifest and removes an inserted entry', async () => {
  await store.insertEntry(entry(), manifest())
  const original = await store.getEntry('b1')
  const originalDigests = bytes(await store.getChunkDigests('b1'))
  await expect(
    db.withTransaction(async (tx) => {
      const target = await getBlobStore(tx)
      await target.deleteEntry('b1')
      expect(await target.getEntry('b1')).toBeNull()
      expect(await target.getChunkDigests('b1')).toEqual([])
      await target.insertEntry(entry({ blobID: 'b2' }), manifest())
      expect(await target.getEntry('b2')).not.toBeNull()
      expect(await target.getChunkDigests('b2')).toHaveLength(3)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await store.getEntry('b1')).toEqual(original)
  expect(bytes(await store.getChunkDigests('b1'))).toEqual(originalDigests)
  expect(await store.getEntry('b2')).toBeNull()
  expect(await store.getChunkDigests('b2')).toEqual([])
})

test('setPinned toggles pinned', async () => {
  await store.insertEntry(entry(), [])
  await store.setPinned('b1', true)
  expect((await store.getEntry('b1'))?.pinned).toBe(true)
  await store.setPinned('b1', false)
  expect((await store.getEntry('b1'))?.pinned).toBe(false)
})
test('insertEntry rolls back its entry and earlier manifest batches on failure', async () => {
  adapter.database.exec(
    'CREATE TRIGGER fail_chunk BEFORE INSERT ON hozon_blob_chunks WHEN NEW."index" = 170 BEGIN SELECT RAISE(ABORT, \'chunk failed\'); END',
  )
  await expect(store.insertEntry(entry(), manifest(200))).rejects.toThrow('chunk failed')
  expect(await store.getEntry('b1')).toBeNull()
  expect(await store.getChunkDigests('b1')).toEqual([])
})
test('contentType round-trips and defaults to null', async () => {
  await store.insertEntry(entry({ blobID: 'ct', contentType: 'image/png' }), [])
  await store.insertEntry(entry({ blobID: 'none' }), [])
  expect((await store.getEntry('ct'))?.contentType).toBe('image/png')
  expect((await store.getEntry('none'))?.contentType).toBeNull()
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
  await expect(store.listEntries({ limit: 2, cursor: 'not-a-cursor!' })).rejects.toThrow(
    InvalidCursorError,
  )
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
test('promoteEntry works on a remote-only stub with chunkSize 0', async () => {
  await store.insertEntry(entry({ state: 'remote-only', chunkSize: 0 }), [])
  const { state: _state, ...input } = entry()
  await store.promoteEntry(input, manifest())
  expect(await store.getEntry('b1')).toMatchObject({ state: 'local', chunkSize: 4 })
  expect(await store.getChunkDigests('b1')).toHaveLength(3)
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

function entryQueryCount(prepare: { mock: { calls: Array<Array<unknown>> } }): number {
  return prepare.mock.calls.filter(([sql]) =>
    /select .* from "hozon_blob_entries"/i.test(String(sql)),
  ).length
}

test('getEntries returns every requested key with null for missing', async () => {
  await store.insertEntry(entry({ blobID: 'a' }), [])
  const result = await store.getEntries(['a', 'zz', 'a'])
  expect(result.size).toBe(2)
  expect(result.get('a')).toEqual({
    ...entry({ blobID: 'a' }),
    contentType: null,
    encrypted: false,
    keyID: null,
    pinned: false,
  })
  expect(result.get('zz')).toBeNull()
})
test('getEntries throws BatchLimitError above 500 unique IDs or above batchLimit', async () => {
  const ids = Array.from({ length: 501 }, (_, index) => `id-${index}`)
  await expect(store.getEntries(ids)).rejects.toBeInstanceOf(BatchLimitError)
  await expect(store.getEntries(['a', 'b', 'c'], { batchLimit: 2 })).rejects.toBeInstanceOf(
    BatchLimitError,
  )
  await expect(
    store.getEntries([...ids.slice(0, 500), ...ids.slice(0, 10)]),
  ).resolves.toBeInstanceOf(Map)
})
test('getEntries returns an empty map for empty input', async () => {
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const result = await store.getEntries([])
  expect(result.size).toBe(0)
  expect(entryQueryCount(prepare)).toBe(0)
})
test('concurrent getEntry calls run one query', async () => {
  await store.insertEntry(entry({ blobID: 'a' }), [])
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const results = await Promise.all([
    store.getEntry('a'),
    store.getEntry('zz'),
    store.getEntry('a'),
  ])
  expect(results.map((item) => item?.blobID ?? null)).toEqual(['a', null, 'a'])
  expect(entryQueryCount(prepare)).toBe(1)
})
test('getEntry inside a scope sees setPinned', async () => {
  await store.insertEntry(entry({ blobID: 'a' }), [])
  await db.withScope<{ blob: BlobStoreAPI }, void>(async (scope) => {
    const scoped = await scope.getStore('blob')
    expect((await scoped.getEntry('a'))?.pinned).toBe(false)
    await scoped.setPinned('a', true)
    expect((await scoped.getEntry('a'))?.pinned).toBe(true)
  })
})
test('getEntries bypasses remembered values inside a scope', async () => {
  await store.insertEntry(entry({ blobID: 'a' }), [])
  await db.withScope<{ blob: BlobStoreAPI }, void>(async (scope) => {
    const scoped = await scope.getStore('blob')
    expect((await scoped.getEntry('a'))?.pinned).toBe(false)
    await store.setPinned('a', true)
    expect((await scoped.getEntry('a'))?.pinned).toBe(false)
    expect((await scoped.getEntries(['a'])).get('a')?.pinned).toBe(true)
  })
})

test('getEntry outside a scope reads fresh after a batch settles', async () => {
  await store.insertEntry(entry(), [])
  expect((await store.getEntry('b1'))?.contentType).toBeNull()
  adapter.database.exec("UPDATE hozon_blob_entries SET content_type = 'text/plain'")
  expect((await store.getEntry('b1'))?.contentType).toBe('text/plain')
})

type MutationName = 'insertEntry' | 'setPinned' | 'deleteEntry' | 'promoteEntry' | 'fillContentType'
const mutations: Record<MutationName, (target: BlobStoreAPI) => Promise<void>> = {
  insertEntry: (target) => target.insertEntry(entry(), []),
  setPinned: (target) => target.setPinned('b1', true),
  deleteEntry: (target) => target.deleteEntry('b1'),
  promoteEntry: (target) => target.promoteEntry(entry(), []),
  fillContentType: (target) => target.fillContentType('b1', 'text/plain'),
}
test.each(Object.keys(mutations) as Array<MutationName>)(
  '%s clears the remembered entry inside a scope',
  async (name) => {
    await store.insertEntry(entry({ state: 'remote-only' }), manifest())
    const prepare = vi.spyOn(adapter.database, 'prepare')
    await db.withScope<{ blob: BlobStoreAPI }, void>(async (scope) => {
      const scoped = await scope.getStore('blob')
      await scoped.getEntry('b1')
      await scoped.getEntry('b1')
      expect(entryQueryCount(prepare)).toBe(1)
      await mutations[name](scoped)
      const afterMutation = entryQueryCount(prepare)
      await scoped.getEntry('b1')
      expect(entryQueryCount(prepare)).toBe(afterMutation + 1)
    })
  },
)
