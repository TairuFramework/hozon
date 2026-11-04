import { blake3Codec } from '@hozon/blob-id'
import { getBlobStore, withBlobLocks } from '@hozon/store-blob'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

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
})
