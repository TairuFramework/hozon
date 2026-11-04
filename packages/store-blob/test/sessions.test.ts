import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { blobStoreDefinition, getBlobStore, InvalidCursorError } from '../src/index.js'
import type { BlobSessionInput, BlobStoreAPI } from '../src/types.js'

let db: HozonDB
let adapter: NodeSQLiteAdapter
let store: BlobStoreAPI
beforeEach(async () => {
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter })
  db.register(blobStoreDefinition)
  store = await getBlobStore(db)
  await store.insertEntry(
    {
      blobID: 'b1',
      contentLength: 8,
      chunkSize: 4,
      state: 'remote-only',
      createdAt: 5,
      pinned: true,
    },
    [],
  )
})
afterEach(async () => {
  await db.close()
})
function session(overrides: Partial<BlobSessionInput> = {}): BlobSessionInput {
  return {
    blobID: 'b1',
    owner: 'owner-a',
    stagingID: 't-a',
    contentLength: 8,
    chunkSize: 4,
    contentType: 'text/plain',
    encrypted: true,
    keyID: 'key-a',
    createdAt: 10,
    updatedAt: 10,
    chunks: [
      { index: 0, digest: new Uint8Array([1]) },
      { index: 1, digest: new Uint8Array([2]) },
    ],
    ...overrides,
  }
}

test('sessions keep independent manifests, progress and metadata per owner', async () => {
  expect(await store.getSession('b1', 'owner-a')).toBeNull()
  await store.putSession(session())
  await store.putSession(
    session({
      owner: 'owner-b',
      stagingID: 't-b',
      chunkSize: 8,
      chunks: [{ index: 0, digest: new Uint8Array([9]) }],
    }),
  )
  await store.markSessionChunk('b1', 'owner-a', 1)
  await store.markSessionChunk('b1', 'owner-a', 1)
  const a = await store.getSession('b1', 'owner-a')
  expect(a).toMatchObject({
    ...session(),
    updatedAt: expect.any(Number),
    chunks: [
      { index: 0, digest: new Uint8Array([1]), present: false },
      { index: 1, digest: new Uint8Array([2]), present: true },
    ],
    presentChunks: [1],
  })
  expect((await store.getSession('b1', 'owner-b'))?.presentChunks).toEqual([])
  expect(await store.getSessionByStagingID('t-a')).toEqual(a)
  expect(await store.getSessionByStagingID('missing')).toBeNull()
  expect(await store.sumSessionContentLength()).toBe(16)
  expect((await store.getEntry('b1'))?.state).toBe('remote-only')
  expect(await store.getChunkDigests('b1')).toEqual([])
  await store.touchSession('b1', 'owner-b')
  expect((await store.getSession('b1', 'owner-b'))?.updatedAt).toBeGreaterThan(10)
})

test('replacement clears only its session chunks and retains other owners', async () => {
  await store.putSession(session())
  await store.putSession(session({ owner: 'owner-b', stagingID: 't-b' }))
  await store.markSessionChunk('b1', 'owner-a', 0)
  await store.deleteRelease('b1')
  await store.putSession(session({ stagingID: 't-new' }))
  expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toHaveLength(1)
  expect(await store.getSessionByStagingID('t-a')).toBeNull()
  expect((await store.getSession('b1', 'owner-a'))?.presentChunks).toEqual([])
  expect(await store.getSession('b1', 'owner-b')).not.toBeNull()
  expect(
    adapter.database
      .prepare('SELECT * FROM hozon_blob_fetch_chunks WHERE staging_id = ?')
      .all('t-a'),
  ).toEqual([])
})

test('session mutations reject absent sessions and chunks without creating progress', async () => {
  await expect(store.markSessionChunk('b1', 'owner-a', 0)).rejects.toThrow()
  await store.putSession(session())
  await expect(store.markSessionChunk('b1', 'owner-a', 2)).rejects.toThrow()
  expect((await store.getSession('b1', 'owner-a'))?.presentChunks).toEqual([])
  await store.deleteSession('b1', 'owner-a')
  await store.touchSession('b1', 'owner-a')
  await expect(store.markSessionChunk('b1', 'owner-a', 0)).rejects.toThrow()
  expect(await store.sumSessionContentLength()).toBe(0)
  await expect(store.putSession(session({ blobID: 'missing' }))).rejects.toThrow()
  expect(await store.getSessionByStagingID('t-a')).toBeNull()
})

test('session list pages by owner and blob with exact prefix bounds', async () => {
  for (const [i, owner] of ['owner-a/1', 'owner-a/2', 'owner-ab/1', 'owner-b'].entries()) {
    await store.putSession(session({ owner, stagingID: `t-${i}` }))
  }
  const page = await store.listSessions({ ownerPrefix: 'owner-a/', limit: 1 })
  expect(page.sessions.map((s) => s.owner)).toEqual(['owner-a/1'])
  expect(page.nextCursor).not.toBeNull()
  const last = await store.listSessions({
    ownerPrefix: 'owner-a/',
    limit: 1,
    cursor: page.nextCursor ?? undefined,
  })
  expect(last.sessions.map((s) => s.owner)).toEqual(['owner-a/2'])
  expect(last.nextCursor).toBeNull()
  expect((await store.listSessions({ owner: 'owner-b', limit: 10 })).sessions).toHaveLength(1)
  expect((await store.listSessions({ blobID: 'b1', limit: 10 })).sessions).toHaveLength(4)
  await expect(store.listSessions({ limit: 0 })).rejects.toThrow()
  await expect(store.listSessions({ limit: 10, cursor: 'bad' })).rejects.toThrow(InvalidCursorError)
})

test('session endings refresh releases and promotion replaces layout and every session', async () => {
  await store.putSession(session())
  await store.putSession(session({ owner: 'owner-b', stagingID: 't-b' }))
  await store.deleteRelease('b1')
  await store.deleteSession('b1', 'owner-a')
  expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toHaveLength(1)
  expect(await store.getSession('b1', 'owner-b')).not.toBeNull()
  await store.enqueueByteDeletion('b1')
  await store.promoteEntry(
    { blobID: 'b1', contentLength: 8, chunkSize: 8, createdAt: 99, pinned: false },
    [{ index: 0, digest: new Uint8Array([9]) }],
  )
  expect(await store.getEntry('b1')).toMatchObject({
    state: 'local',
    chunkSize: 8,
    pinned: true,
    createdAt: 5,
  })
  expect(await store.getChunkDigests('b1')).toEqual([new Uint8Array([9])])
  expect((await store.listSessions({ blobID: 'b1', limit: 10 })).sessions).toEqual([])
  expect(await store.listByteDeletions()).toEqual([])
  expect(await store.sumSessionContentLength()).toBe(0)
  expect(adapter.database.prepare('SELECT * FROM hozon_blob_fetch_chunks').all()).toEqual([])
})

test('deleteSessions and entry cascade remove session chunks', async () => {
  await store.putSession(session())
  await store.deleteSessions('b1')
  expect(await store.sumSessionContentLength()).toBe(0)
  await store.putSession(session())
  await store.deleteEntry('b1')
  expect(await store.getSessionByStagingID('t-a')).toBeNull()
  expect(adapter.database.prepare('SELECT * FROM hozon_blob_fetch_chunks').all()).toEqual([])
})

test('600 session chunks use four bindings per row within 500 parameters', async () => {
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const chunks = Array.from({ length: 600 }, (_, index) => ({
    index,
    digest: new Uint8Array([index % 256]),
  }))
  await store.putSession(session({ chunks }))
  expect((await store.getSession('b1', 'owner-a'))?.chunks).toHaveLength(600)
  const counts = prepare.mock.calls.map(([sql]) => (sql.match(/\?/g) ?? []).length)
  expect(Math.max(...counts)).toBe(500)
  expect(counts.filter((n) => n === 500)).toHaveLength(4)
})

test('session replacement and earlier chunk batches roll back on failure', async () => {
  await store.putSession(session())
  await store.markSessionChunk('b1', 'owner-a', 0)
  adapter.database.exec(
    'CREATE TRIGGER fail_chunk BEFORE INSERT ON hozon_blob_fetch_chunks WHEN NEW."index" = 170 BEGIN SELECT RAISE(ABORT, \'chunk failed\'); END',
  )
  const chunks = Array.from({ length: 200 }, (_, index) => ({ index, digest: new Uint8Array([1]) }))
  await expect(store.putSession(session({ stagingID: 't-new', chunks }))).rejects.toThrow(
    'chunk failed',
  )
  expect((await store.getSession('b1', 'owner-a'))?.presentChunks).toEqual([0])
  expect(await store.getSessionByStagingID('t-new')).toBeNull()
})

test('session mutations share caller transaction rollback', async () => {
  await expect(
    db.withTransaction(async (tx) => {
      const scoped = await getBlobStore(tx)
      await scoped.putSession(session())
      await scoped.markSessionChunk('b1', 'owner-a', 0)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await store.getSession('b1', 'owner-a')).toBeNull()
})

test('session tables honour a custom table prefix and entry cascade', async () => {
  await db.close()
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter, tablePrefix: 'kubun' })
  db.register(blobStoreDefinition)
  store = await getBlobStore(db)
  await store.insertEntry(
    { blobID: 'b1', contentLength: 8, chunkSize: 4, state: 'remote-only', createdAt: 5 },
    [],
  )
  await store.putSession(session())
  await store.markSessionChunk('b1', 'owner-a', 0)
  expect((await store.getSession('b1', 'owner-a'))?.presentChunks).toEqual([0])
  const names = adapter.database
    .prepare('SELECT name FROM sqlite_master ORDER BY name')
    .all()
    .map((row) => row.name)
  expect(names).toEqual(
    expect.arrayContaining([
      'kubun_blob_entries',
      'kubun_blob_chunks',
      'kubun_blob_fetch_sessions',
      'kubun_blob_fetch_chunks',
    ]),
  )
  expect(names.some((name) => String(name).startsWith('kubun_kubun_'))).toBe(false)
  await store.deleteEntry('b1')
  expect(await store.getSessionByStagingID('t-a')).toBeNull()
})

test.each(['getSession', 'getSessionByStagingID'] as const)(
  '%s reads session metadata and chunks from one database snapshot',
  async (method) => {
    await store.putSession(session())
    await store.markSessionChunk('b1', 'owner-a', 0)
    const prepare = adapter.database.prepare.bind(adapter.database)
    let removed = false
    const spy = vi.spyOn(adapter.database, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (sql.includes('from "hozon_blob_fetch_sessions"') && !removed) {
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...params) => {
          const rows = all(...params)
          if (!removed) {
            removed = true
            prepare('DELETE FROM hozon_blob_fetch_sessions WHERE blob_id = ?').run('b1')
          }
          return rows
        })
      }
      return statement
    })
    try {
      const found =
        method === 'getSession'
          ? await store.getSession('b1', 'owner-a')
          : await store.getSessionByStagingID('t-a')
      expect(removed).toBe(true)
      expect(found?.chunks).toHaveLength(2)
      expect(found?.presentChunks).toEqual([0])
    } finally {
      spy.mockRestore()
    }
    expect(await store.getSession('b1', 'owner-a')).toBeNull()
  },
)
