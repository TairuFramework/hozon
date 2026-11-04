import { blake3Codec } from '@hozon/blob-id'
import type { Kysely } from '@hozon/db'
import { HozonDB, TransactionScopeError } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { blobStoreDefinition, getBlobStore, withBlobLocks } from '@hozon/store-blob'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { BlobReferencedError, createBlobService } from '../src/index.js'
import { deferred, gatedBackend } from './gated-backend.js'
import { bytesOf, createTestService, digestOf, sourceOf } from './helpers.js'

let ctx: Awaited<ReturnType<typeof createTestService>>
const body = bytesOf(20)
const id = blake3Codec.encode({ digest: digestOf(body), contentLength: body.length })
const ref = { blobID: id, kind: 'doc', key: 'owner-a/1' }
const cutoff = () => new Date(Date.now() + 1000)
const write = () => ctx.service.write({ stream: sourceOf(body).stream })
beforeEach(async () => {
  ctx = await createTestService({ logger: { error: vi.fn() } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.db.close()
})

test('collect deletes unheld blobs and clears the journal but honours grace', async () => {
  await write()
  expect(await ctx.service.collect({ releasedBefore: new Date(0) })).toEqual({
    deleted: 0,
    kept: 0,
    failed: 0,
  })
  expect(await ctx.service.collect({ releasedBefore: cutoff() })).toEqual({
    deleted: 1,
    kept: 0,
    failed: 0,
  })
  expect(await ctx.service.get(id)).toBeNull()
  expect(await ctx.backend.has(id)).toBe(false)
  expect(await ctx.store.listByteDeletions()).toEqual([])
})

test('refs before collection keep a blob; refs after collection return null', async () => {
  await write()
  expect((await ctx.service.addRefs([ref])).get(id)?.state).toBe('local')
  expect(await ctx.service.collect({ releasedBefore: cutoff() })).toEqual({
    deleted: 0,
    kept: 1,
    failed: 0,
  })
  await ctx.service.removeRefs([ref])
  await ctx.service.collect({ releasedBefore: cutoff() })
  expect((await ctx.service.addRefs([ref])).get(id)).toBeNull()
  expect(await ctx.service.get(id)).toBeNull()
})

test('two holders require both removals; removal in a rolled-back caller releases nothing', async () => {
  await write()
  const other = { ...ref, key: 'owner-a/2' }
  await ctx.service.addRefs([ref, other])
  expect(await ctx.service.removeRefs([ref])).toBe(1)
  expect((await ctx.service.collect({ releasedBefore: cutoff() })).kept).toBe(1)
  await expect(
    ctx.db.withTransaction(async (tx) => {
      expect(
        await ctx.service.using(tx).removeHolders({ kind: 'doc', keyPrefix: 'owner-a/' }),
      ).toBe(1)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await ctx.service.listRefs(id)).toHaveLength(1)
  expect(await ctx.store.listReleases({ releasedBefore: cutoff() })).toEqual([])
  expect(await ctx.service.removeHolders({ kind: 'doc', key: other.key })).toBe(1)
  expect((await ctx.service.collect({ releasedBefore: cutoff() })).deleted).toBe(1)
})

test('pin blocks collection and unpin starts a fresh grace period', async () => {
  await write()
  await ctx.service.setPinned(id, true)
  expect((await ctx.service.collect({ releasedBefore: cutoff() })).kept).toBe(1)
  const before = new Date(Date.now())
  await ctx.service.setPinned(id, false)
  expect((await ctx.service.collect({ releasedBefore: before })).deleted).toBe(0)
  expect((await ctx.service.collect({ releasedBefore: cutoff() })).deleted).toBe(1)
})

test('refs may precede entries and fetch sessions block collection until pruned', async () => {
  expect((await ctx.service.addRefs([ref])).get(id)).toBeNull()
  await ctx.service.beginFetch(id, {
    contentLength: body.length,
    chunkSize: 65536,
    chunks: [digestOf(body)],
  })
  expect((await ctx.service.collect({ releasedBefore: cutoff() })).kept).toBe(1)
  await ctx.service.removeRefs([ref])
  expect((await ctx.service.collect({ releasedBefore: cutoff() })).kept).toBe(1)
  await ctx.service.stageChunk({ id, index: 0, bytes: body })
  await ctx.service.pruneStaging(cutoff())
  expect((await ctx.service.collect({ releasedBefore: cutoff() })).deleted).toBe(1)
})

test('failed byte deletion leaves a journal for replay including already absent bytes', async () => {
  await write()
  const remove = vi.spyOn(ctx.backend, 'delete').mockRejectedValueOnce(new Error('crash'))
  expect(await ctx.service.collect({ releasedBefore: cutoff() })).toEqual({
    deleted: 0,
    kept: 0,
    failed: 1,
  })
  expect(await ctx.service.get(id)).toBeNull()
  expect(await ctx.store.listByteDeletions()).toHaveLength(1)
  remove.mockRestore()
  await ctx.backend.delete(id)
  expect(await ctx.service.drainByteDeletions()).toEqual({ deleted: 1, failed: 0 })
  expect(await ctx.store.listByteDeletions()).toEqual([])
})

test('delete refuses refs without changes; force removes refs, entry and bytes', async () => {
  await write()
  await ctx.service.addRefs([ref])
  await expect(ctx.service.delete(id)).rejects.toBeInstanceOf(BlobReferencedError)
  expect(await ctx.service.has(id)).toBe(true)
  expect(await ctx.service.listRefs(id)).toHaveLength(1)
  expect(await ctx.service.delete(id, { force: true })).toBe(true)
  expect(await ctx.service.listRefs(id)).toEqual([])
  expect(await ctx.backend.has(id)).toBe(false)
})

test('holder selectors, pagination and batches preserve exact ASCII bounds', async () => {
  const refs = Array.from({ length: 600 }, (_, i) => ({
    ...ref,
    key: `ab/${String(i).padStart(3, '0')}`,
  }))
  await expect(ctx.service.addRefs(refs)).rejects.toThrow()
  await ctx.service.addRefs(refs.slice(0, 500))
  await ctx.service.addRefs(refs.slice(500))
  await ctx.service.addRefs([
    { ...ref, key: 'a' },
    { ...ref, key: 'ac' },
  ])
  const first = await ctx.service.findRefs({ kind: 'doc', keyPrefix: 'ab', blobID: id, limit: 400 })
  const last = await ctx.service.findRefs({
    kind: 'doc',
    keyPrefix: 'ab',
    limit: 400,
    cursor: first.nextCursor ?? undefined,
  })
  expect(first.refs).toHaveLength(400)
  expect(last.refs).toHaveLength(200)
  expect(last.nextCursor).toBeNull()
  expect((await ctx.service.findRefs({ kind: 'doc', key: 'a', limit: 10 })).refs).toHaveLength(1)
  expect(await ctx.service.removeRefs(refs)).toBe(600)
  expect(await ctx.service.removeHolders({ kind: 'doc', keyPrefix: 'a' })).toBe(2)
})

test.each([
  { kind: 'Doc', key: 'a' },
  { kind: '', key: 'a' },
  { kind: 'x'.repeat(65), key: 'a' },
  { kind: 'doc', key: '' },
  { kind: 'doc', key: 'é' },
  { kind: 'doc\n', key: 'a' },
  { kind: 'doc', key: 'a\n' },
  { kind: 'doc', key: '\x7f' },
  { kind: 'doc', key: '\n' },
  { kind: 'doc', key: 'x'.repeat(513) },
])('invalid holder is rejected without mutation: %j', async (holder) => {
  await expect(ctx.service.addRefs([{ blobID: id, ...holder }])).rejects.toThrow()
  await expect(ctx.service.removeRefs([{ blobID: id, ...holder }])).rejects.toThrow()
  await expect(ctx.service.removeHolders(holder)).rejects.toThrow()
  await expect(ctx.service.findRefs({ ...holder, limit: 10 })).rejects.toThrow()
  expect(await ctx.service.listRefs(id)).toEqual([])
})

test('a writer waiting behind collection byte deletion republishes safely', async () => {
  await ctx.db.close()
  const gate = gatedBackend()
  ctx = await createTestService({ backend: gate.backend })
  await write()
  const parked = gate.park('delete')
  const collecting = ctx.service.collect({ releasedBefore: cutoff() })
  await parked.entered
  const writing = write()
  parked.release()
  await Promise.all([collecting, writing])
  expect(await ctx.service.has(id)).toBe(true)
  expect(await ctx.backend.has(id)).toBe(true)
})

test('collection waits for a caller write and then sees its ref', async () => {
  const written = deferred()
  const release = deferred()
  const caller = ctx.db.withTransaction(async (tx) => {
    const ops = ctx.service.using(tx)
    await ops.write({ stream: sourceOf(body).stream })
    await ops.addRefs([ref])
    written.resolve()
    await release.promise
  })
  await written.promise
  const collecting = ctx.service.collect({ releasedBefore: cutoff() })
  release.resolve()
  await caller
  expect(await collecting).toEqual({ deleted: 0, kept: 1, failed: 0 })
  expect(await ctx.backend.has(id)).toBe(true)
})

test.each(['write', 'fetch'] as const)(
  'a %s between durable collection phases preserves published bytes',
  async (operation) => {
    await write()
    await withBlobLocks(ctx.db, [id], async (tx) => {
      const store = await getBlobStore(tx)
      await store.deleteEntry(id)
      await store.enqueueByteDeletion(id)
    })
    if (operation === 'write') await write()
    else {
      await ctx.service.beginFetch(id, {
        contentLength: body.length,
        chunkSize: 65536,
        chunks: [digestOf(body)],
      })
      await ctx.service.stageChunk({ id, index: 0, bytes: body })
      await ctx.service.completeFetch(id)
    }
    expect(await ctx.store.listByteDeletions()).toEqual([])
    await ctx.service.drainByteDeletions()
    expect(await ctx.backend.has(id)).toBe(true)
  },
)

test('delete and addRefs serialise in either order', async () => {
  await write()
  await ctx.service.withLocks([id], async (ops) => {
    await ops.addRefs([ref])
    await expect(ops.delete(id)).rejects.toBeInstanceOf(BlobReferencedError)
  })
  await ctx.service.withLocks([id], async (ops) => {
    await ops.delete(id, { force: true })
    expect((await ops.addRefs([ref])).get(id)).toBeNull()
  })
})

test('entries predating holder migration survive collection without release rows', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  db.register(blobStoreDefinition)
  try {
    await getBlobStore(db)
    if (typeof blobStoreDefinition.migrations !== 'function')
      throw new Error('Expected migration factory')
    const migration = blobStoreDefinition.migrations({
      tablePrefix: 'hozon',
      kind: adapter.kind,
      types: adapter.types,
      functions: adapter.functions,
    })['3-holders']
    if (migration?.down === undefined) throw new Error('Missing migration')
    db.register<Record<string, unknown>, Kysely<Record<string, unknown>>>({
      name: 'raw',
      migrations: {},
      createAPI: (query) => query,
    })
    const raw = await db.getStore<Kysely<Record<string, unknown>>>('raw')
    await migration.down(raw)
    adapter.database
      .prepare(
        'INSERT INTO hozon_blob_entries (blob_id, content_length, chunk_size, state, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, body.length, 65536, 'local', 1)
    await migration.up(raw)
    const service = createBlobService({ db, backend: ctx.backend })
    expect(await service.collect({ releasedBefore: cutoff() })).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0,
    })
    expect((await service.get(id))?.createdAt).toBe(1)
  } finally {
    await db.close()
  }
})

test.each(['refresh', 'remove'] as const)(
  'collection rechecks a release changed after candidate selection: %s',
  async (change) => {
    await write()
    const original = ctx.store.listReleases.bind(ctx.store)
    vi.spyOn(ctx.store, 'listReleases').mockImplementationOnce(async (params) => {
      const rows = await original(params)
      if (change === 'refresh') await ctx.store.upsertReleases([id], Date.now() + 5000)
      else await ctx.store.deleteRelease(id)
      return rows
    })
    expect(await ctx.service.collect({ releasedBefore: cutoff() })).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0,
    })
    expect(await ctx.service.has(id)).toBe(true)
  },
)

test.each(['refs', 'holder'] as const)(
  'root-bound %s removal inside a caller transaction throws instead of hanging',
  async (kind) => {
    await write()
    await ctx.service.addRefs([ref])
    let pending: Promise<unknown> | undefined
    let outcome: unknown
    await ctx.db.withTransaction(async () => {
      pending = (
        kind === 'refs'
          ? ctx.service.removeRefs([ref])
          : ctx.service.removeHolders({ kind: ref.kind, key: ref.key })
      ).then(
        () => 'removed',
        (error: unknown) => error,
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        outcome = await Promise.race([
          pending,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('blocked'), 50)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    })
    await pending
    expect(outcome).toBeInstanceOf(TransactionScopeError)
  },
)
