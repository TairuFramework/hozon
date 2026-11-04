import { blake3Codec } from '@hozon/blob-id'
import { blobStoreDefinition, getBlobStore, withBlobLocks } from '@hozon/store-blob'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { BlobReferencedError, createBlobService } from '../src/index.js'
import { deferred } from './gated-backend.js'
import { bytesOf, digestOf, sourceOf } from './helpers.js'
import { createPostgresService, type RowsAPI, startBlobPostgres } from './locking-postgres.js'

const body = bytesOf(20)
const id = blake3Codec.encode({ digest: digestOf(body), contentLength: body.length })
const otherBody = bytesOf(21)
const otherID = blake3Codec.encode({ digest: digestOf(otherBody), contentLength: otherBody.length })
const write = () => ({ stream: sourceOf(body).stream })
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

describe.skipIf(process.env.HOZON_BLOB_POSTGRES !== '1')('Postgres blob locking', () => {
  let server: Awaited<ReturnType<typeof startBlobPostgres>>
  const cleanups: Array<() => Promise<void>> = []
  beforeAll(async () => {
    server = await startBlobPostgres()
  }, 120_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })
  afterAll(async () => {
    await server?.stop()
  })
  async function setup() {
    const context = await createPostgresService(server.url)
    cleanups.push(context.cleanup)
    return context
  }

  test('caller writes block deletion drains until commit', async () => {
    const { db, service, backend } = await setup()
    await withBlobLocks(db, [id], async (tx) => {
      await (await getBlobStore(tx)).enqueueByteDeletion(id)
    })
    const written = deferred()
    const release = deferred()
    const caller = db.withTransaction(async (tx) => {
      await service.using(tx).write(write())
      written.resolve()
      await release.promise
    })
    await written.promise
    let drained = false
    const drain = service.drainByteDeletions().then(() => {
      drained = true
    })
    try {
      await tick()
      expect(drained).toBe(false)
    } finally {
      release.resolve()
    }
    await Promise.all([caller, drain])
    expect(await backend.has(id)).toBe(true)
    expect(await service.has(id)).toBe(true)
  }, 15_000)

  test('rollback reclaim preserves a queued writer', async () => {
    const { db, service, backend } = await setup()
    const written = deferred()
    const release = deferred()
    const caller = db.withTransaction(async (tx) => {
      await service.using(tx).write(write())
      written.resolve()
      await release.promise
      throw new Error('rollback')
    })
    const rejected = expect(caller).rejects.toThrow('rollback')
    await written.promise
    const queued = service.write(write())
    release.resolve()
    await rejected
    await queued
    await tick()
    expect(await backend.has(id)).toBe(true)
    expect(await service.has(id)).toBe(true)
  }, 15_000)

  test('rollback reclaims orphan bytes without a queued writer', async () => {
    const { db, service, backend } = await setup()
    await expect(
      db.withTransaction(async (tx) => {
        await service.using(tx).write(write())
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    for (let attempt = 0; attempt < 100 && (await backend.has(id)); attempt++) await tick()
    expect(await backend.has(id)).toBe(false)
    expect(await service.get(id)).toBeNull()
  }, 15_000)

  test('opposite multi-lock orders complete with lock-scoped operations', async () => {
    const { service } = await setup()
    await service.write(write())
    await service.write({ stream: sourceOf(otherBody).stream })
    await Promise.all(
      [
        [id, otherID],
        [otherID, id],
      ].map((ids) =>
        service.withLocks(ids, async (ops) => {
          await ops.setPinned(id, true)
          await ops.setPinned(otherID, true)
          await ops.withLocks(ids, async (nested) => {
            expect(await nested.has(id)).toBe(true)
          })
        }),
      ),
    )
  }, 15_000)

  test('row and blob lock inversion raises a real deadlock without caller retry', async () => {
    const { db, service } = await setup()
    const rowHeld = deferred()
    const blobHeld = deferred()
    let rowCallerRuns = 0
    let blobCallerRuns = 0
    const rowFirst = db.withTransaction(async (tx) => {
      rowCallerRuns++
      await ((await tx.getStore('rows')) as RowsAPI).lock()
      rowHeld.resolve()
      await blobHeld.promise
      await service.using(tx).withLocks([id], async () => {})
    })
    const blobFirst = db.withTransaction(async (tx) => {
      blobCallerRuns++
      await rowHeld.promise
      await service.using(tx).withLocks([id], async () => {
        blobHeld.resolve()
        await ((await tx.getStore('rows')) as RowsAPI).lock()
      })
    })
    const results = await Promise.allSettled([rowFirst, blobFirst])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected').map((result) => result.reason),
    ).toEqual([expect.objectContaining({ code: '40P01' })])
    expect([rowCallerRuns, blobCallerRuns]).toEqual([1, 1])
  }, 15_000)

  test('hozon transactions retry deadlock errors at most three times with distinct delays', async () => {
    const { service } = await setup()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    let attempts = 0
    await expect(
      service.withLocks([id], async (_ops, tx) => {
        attempts++
        await ((await tx.getStore('rows')) as RowsAPI).deadlock()
      }),
    ).rejects.toMatchObject({ code: '40P01' })
    expect(attempts).toBe(3)
    const delays = timer.mock.calls
      .map((call) => call[1])
      .filter((delay) => typeof delay === 'number' && delay >= 10 && delay < 30)
    expect(delays).toHaveLength(2)
    expect(new Set(delays).size).toBe(2)
  }, 15_000)

  test('caller transactions propagate deadlock errors without retry', async () => {
    const { db, service } = await setup()
    let attempts = 0
    await expect(
      db.withTransaction(async (tx) => {
        await service.using(tx).withLocks([id], async () => {
          attempts++
          await ((await tx.getStore('rows')) as RowsAPI).deadlock()
        })
      }),
    ).rejects.toMatchObject({ code: '40P01' })
    expect(attempts).toBe(1)
  }, 15_000)
  test('collection waits for an uncommitted publisher then keeps its referenced entry', async () => {
    const { db, service, backend } = await setup()
    const held = deferred()
    const release = deferred()
    const caller = db.withTransaction(async (tx) => {
      const ops = service.using(tx)
      await ops.write(write())
      await ops.addRefs([{ blobID: id, kind: 'doc', key: 'owner-a' }])
      held.resolve()
      await release.promise
    })
    await held.promise
    const collecting = service.collect({ releasedBefore: new Date(Date.now() + 1000) })
    release.resolve()
    await caller
    await collecting
    expect(await service.has(id)).toBe(true)
    expect(await backend.has(id)).toBe(true)
  }, 15_000)

  test('uncommitted addRefs holds the blob lock against collection and explicit delete', async () => {
    const { db, service, backend } = await setup()
    await service.write(write())
    const held = deferred()
    const release = deferred()
    const caller = db.withTransaction(async (tx) => {
      await service.using(tx).addRefs([{ blobID: id, kind: 'doc', key: 'owner-a' }])
      held.resolve()
      await release.promise
    })
    await held.promise
    let collected = false
    const collecting = service
      .collect({ releasedBefore: new Date(Date.now() + 1000) })
      .then((result) => {
        collected = true
        return result
      })
    const deleting = expect(service.delete(id)).rejects.toBeInstanceOf(BlobReferencedError)
    try {
      await tick()
      expect(collected).toBe(false)
    } finally {
      release.resolve()
    }
    await caller
    expect((await collecting).kept).toBe(1)
    await deleting
    expect(await backend.has(id)).toBe(true)
  }, 15_000)

  test('reconciliation waits for the transaction publishing bytes', async () => {
    const { db, service, backend } = await setup()
    const held = deferred()
    const release = deferred()
    const caller = db.withTransaction(async (tx) => {
      await service.using(tx).write(write())
      held.resolve()
      await release.promise
    })
    await held.promise
    let ended = false
    const reconciling = service
      .reconcileBytes({ olderThan: new Date(Date.now() + 1000) })
      .then((result) => {
        ended = true
        return result
      })
    try {
      await tick()
      expect(ended).toBe(false)
    } finally {
      release.resolve()
    }
    await caller
    expect((await reconciling).deleted).toBe(0)
    expect(await backend.has(id)).toBe(true)
  }, 15_000)

  test('pin and eviction serialise across caller transactions', async () => {
    const { db, service, backend } = await setup()
    await service.write(write())
    const held = deferred()
    const release = deferred()
    const caller = db.withTransaction(async (tx) => {
      await service.using(tx).setPinned(id, true)
      held.resolve()
      await release.promise
    })
    await held.promise
    const evicting = expect(service.evict(id)).rejects.toMatchObject({ name: 'BlobPinnedError' })
    release.resolve()
    await Promise.all([caller, evicting])
    expect(await backend.has(id)).toBe(true)
  }, 15_000)

  test('ref removal during a collector decision leaves a fresh release for the next collection', async () => {
    const { service, store } = await setup()
    await service.write(write())
    const ref = { blobID: id, kind: 'doc', key: 'owner-a' }
    await service.addRefs([ref])
    const counted = deferred()
    const release = deferred()
    let park = true
    const createAPI = blobStoreDefinition.createAPI
    vi.spyOn(blobStoreDefinition, 'createAPI').mockImplementation((query, adapter, context) => {
      const api = createAPI(query, adapter, context)
      const countRefs = api.countRefs
      api.countRefs = async (blobID) => {
        const count = await countRefs(blobID)
        if (park && blobID === id) {
          park = false
          counted.resolve()
          await release.promise
        }
        return count
      }
      return api
    })
    const collecting = service.collect({ releasedBefore: new Date(Date.now() + 1000) })
    await counted.promise
    const removing = service.removeRefs([ref])
    try {
      await tick()
    } finally {
      release.resolve()
    }
    await Promise.all([collecting, removing])
    expect(await store.countRefs(id)).toBe(0)
    expect(await store.listReleases({ releasedBefore: new Date(Date.now() + 1000) })).toHaveLength(
      1,
    )
    expect((await service.collect({ releasedBefore: new Date(Date.now() + 1000) })).deleted).toBe(1)
  }, 15_000)
  test.each([{ owner: 'owner-a' }, { ownerPrefix: 'owner-a' }])(
    'bulk abort in a caller transaction serialises matching begins: %j',
    async (selector) => {
      const { db, service } = await setup()
      const key = { id, owner: 'owner-a' }
      const manifest = { contentLength: body.length, chunkSize: 1024, chunks: [digestOf(body)] }
      await service.beginFetch({ ...key, manifest })
      const held = deferred()
      const release = deferred()
      const caller = db.withTransaction(async (tx) => {
        expect(await service.using(tx).abortFetches(selector)).toBe(1)
        held.resolve()
        await release.promise
      })
      await held.promise
      let began = false
      const begin = service.beginFetch({ ...key, manifest }).then((r) => {
        began = true
        return r
      })
      try {
        await tick()
        expect(began).toBe(false)
      } finally {
        release.resolve()
      }
      await caller
      expect((await begin).status).toBe('started')
    },
    15_000,
  )

  test('parallel owner completions publish once without losing bytes', async () => {
    const { service, backend } = await setup()
    const keys = ['owner-a', 'owner-b'].map((owner) => ({ id, owner }))
    for (const key of keys) {
      await service.beginFetch({
        ...key,
        manifest: { contentLength: body.length, chunkSize: 1024, chunks: [digestOf(body)] },
      })
      await service.stageChunk({ ...key, index: 0, bytes: body })
    }
    const result = await Promise.all(keys.map((key) => service.completeFetch(key)))
    expect(result.map((r) => r.fetched).sort()).toEqual([false, true])
    expect(await backend.has(id)).toBe(true)
  }, 15_000)

  test('new owners on one blob serialise near the staging bound', async () => {
    const { db, backend } = await setup()
    const service = createBlobService({ db, backend, limits: { maxStagingBytes: body.length } })
    const results = await Promise.allSettled(
      ['owner-a', 'owner-b'].map((owner) =>
        service.beginFetch({
          id,
          owner,
          manifest: { contentLength: body.length, chunkSize: 1024, chunks: [digestOf(body)] },
        }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason)).toEqual([
      expect.objectContaining({ name: 'StagingLimitError' }),
    ])
  }, 15_000)
})
