import { blake3Codec } from '@hozon/blob-id'
import { blobStoreDefinition, getBlobStore, withBlobLocks } from '@hozon/store-blob'
import { afterEach, expect, test, vi } from 'vitest'

import {
  BlobNotFoundError,
  type BlobOperations,
  createBlobService,
  StagingLimitError,
} from '../src/index.js'
import { deferred, gatedBackend } from './gated-backend.js'
import { bytesOf, createTestService, digestOf, listStaging, sourceOf } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function setup() {
  const gate = gatedBackend()
  const logError = vi.fn()
  const ctx = await createTestService({ backend: gate.backend, logger: { error: logError } })
  cleanups.push(() => ctx.db.close())
  expect(typeof ctx.service.using).toBe('function')
  return { ...ctx, gate, logError }
}
const body = bytesOf(20)
const id = blake3Codec.encode({ digest: digestOf(body), contentLength: body.length })
const write = () => ({ stream: sourceOf(body).stream })
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

test('a caller write keeps its bytes while a deletion drain waits for commit', async () => {
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
  const drain = service.drainByteDeletions().then((result) => {
    drained = true
    return result
  })
  await tick()
  expect(drained).toBe(false)
  release.resolve()
  await caller
  await drain
  expect(await backend.has(id)).toBe(true)
  expect(await service.has(id)).toBe(true)
})

test('rollback reclaims bytes and a queued writer keeps its committed bytes', async () => {
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
  const next = service.write(write())
  release.resolve()
  await rejected
  await next
  await tick()
  expect(await backend.has(id)).toBe(true)
  expect(await service.has(id)).toBe(true)
})

test('rollback removes orphan bytes without another writer', async () => {
  const { db, service, backend } = await setup()
  await expect(
    db.withTransaction(async (tx) => {
      await service.using(tx).write(write())
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  await tick()
  expect(await backend.has(id)).toBe(false)
  expect(await service.get(id)).toBeNull()
})

test('views share the registry during writes and uncommitted transfers', async () => {
  const { db, service, backend, gate } = await setup()
  const parked = gate.park('commit')
  const caller = db.withTransaction(async (tx) => {
    await service.using(tx).write(write())
  })
  await parked.entered
  expect(await listStaging(backend)).toHaveLength(1)
  expect(await service.pruneStaging(new Date(Date.now() + 10000))).toEqual({
    removed: 0,
    failed: 0,
  })
  parked.release()
  await caller
})

test('withLocks canonicalises and passes a reentrant view for opposite key orders', async () => {
  const { service } = await setup()
  await service.write(write())
  const other = (await service.write({ stream: sourceOf(bytesOf(21)).stream })).entry.blobID
  await Promise.all(
    [
      [id, other],
      [other, id],
    ].map((ids) =>
      service.withLocks(ids, async (ops, tx) => {
        expect(tx.isTransactionBound).toBe(true)
        await ops.setPinned(id, true)
        await ops.setPinned(other, true)
        await ops.withLocks(ids, async (nested) => {
          expect(await nested.has(id)).toBe(true)
        })
      }),
    ),
  )
})

test('root calls fail inside caller transactions while transaction views work', async () => {
  const { db, service } = await setup()
  await db.withTransaction(async (tx) => {
    await expect(service.setPinned(id, true)).rejects.toMatchObject({
      name: 'TransactionScopeError',
    })
    await service.using(tx).write(write())
    expect(await service.using(tx).has(id)).toBe(true)
  })
})

test('streamed and known-length staging limits leave no areas and do not limit reads', async () => {
  const { db, backend, service } = await setup()
  await service.write(write())
  const limited = createBlobService({ db, backend, limits: { maxStagingBytes: 10 } })
  await expect(limited.write({ ...write(), expectedID: id })).rejects.toBeInstanceOf(
    StagingLimitError,
  )
  await expect(limited.write(write())).rejects.toBeInstanceOf(StagingLimitError)
  expect(await listStaging(backend)).toEqual([])
  expect(await limited.createReadStream(id)).toBeInstanceOf(ReadableStream)
})

test('failed byte deletion leaves a replayable journal and missing bytes clear it', async () => {
  const { service, backend, store, gate } = await setup()
  await service.write(write())
  const parked = gate.park('delete')
  const deleting = service.delete(id)
  const rejected = expect(deleting).rejects.toThrow('crash')
  await parked.entered
  parked.fail(new Error('crash'))
  await rejected
  expect(await service.get(id)).toBeNull()
  expect(await store.listByteDeletions()).toHaveLength(1)
  expect(await service.drainByteDeletions()).toEqual({ deleted: 1, failed: 0 })
  expect(await backend.has(id)).toBe(false)
  await store.enqueueByteDeletion(id)
  expect(await service.drainByteDeletions()).toEqual({ deleted: 1, failed: 0 })
  expect(await store.listByteDeletions()).toEqual([])
})

test('a writer waits for a byte deletion and republishes its bytes', async () => {
  const { service, backend, gate } = await setup()
  await service.write(write())
  const parked = gate.park('delete')
  const deleting = service.delete(id)
  await parked.entered
  let finished = false
  const writing = service.write(write()).then(() => {
    finished = true
  })
  await tick()
  expect(finished).toBe(false)
  parked.release()
  await deleting
  await writing
  expect(await backend.has(id)).toBe(true)
  expect(await service.has(id)).toBe(true)
})

test('entry mutations wait for a caller holding the blob lock', async () => {
  const { db, service } = await setup()
  await service.write(write())
  for (const mutate of [
    () => service.write(write()),
    () => service.setPinned(id, true),
    () =>
      service.beginFetch(id, {
        contentLength: body.length,
        chunkSize: 1024,
        chunks: [digestOf(body)],
      }),
    () => service.getPresentChunks(id),
    () => service.delete(id),
  ]) {
    const entered = deferred()
    const release = deferred()
    const held = db.withTransaction(async (tx) => {
      await service.using(tx).withLocks([id], async () => {
        entered.resolve()
        await release.promise
      })
    })
    await entered.promise
    let ended = false
    const pending = mutate().then(() => {
      ended = true
    })
    await tick()
    expect(ended).toBe(false)
    release.resolve()
    await held
    await pending
  }
})

test('a writer between entry removal and byte deletion keeps its bytes', async () => {
  const { db, service, backend, store } = await setup()
  await service.write(write())
  // Persist the same durable boundary that survives a process exit.
  await withBlobLocks(db, [id], async (tx) => {
    const target = await getBlobStore(tx)
    await target.deleteEntry(id)
    await target.enqueueByteDeletion(id)
  })
  await service.write(write())
  expect(await store.listByteDeletions()).toEqual([])
  expect(await service.drainByteDeletions()).toEqual({ deleted: 0, failed: 0 })
  expect(await backend.has(id)).toBe(true)
})

test('transaction-bound delete leaves bytes until commit and preserves them on rollback', async () => {
  const { db, service, backend, gate, store } = await setup()
  await service.write(write())
  await expect(
    db.withTransaction(async (tx) => {
      expect(await service.using(tx).delete(id)).toBe(true)
      expect(await backend.has(id)).toBe(true)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await service.has(id)).toBe(true)
  const parked = gate.park('delete')
  await db.withTransaction(async (tx) => {
    await service.using(tx).delete(id)
    expect(await backend.has(id)).toBe(true)
  })
  await parked.entered
  parked.fail(new Error('backend unavailable'))
  await tick()
  expect(await store.listByteDeletions()).toHaveLength(1)
  expect(await service.drainByteDeletions()).toEqual({ deleted: 1, failed: 0 })
})

test('in-flight writes share the staging budget across provider views', async () => {
  const { db, backend } = await setup()
  const service = createBlobService({ db, backend, limits: { maxStagingBytes: 25 } })
  const staged = deferred()
  const release = deferred()
  const first = service.using(db).write({
    stream: new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(body)
        staged.resolve()
        await release.promise
        controller.close()
      },
    }),
  })
  await staged.promise
  await tick()
  await expect(service.write(write())).rejects.toBeInstanceOf(StagingLimitError)
  release.resolve()
  await first
  expect(await listStaging(backend)).toEqual([])
})

test.each(['commit', 'rollback'] as const)(
  'pruning skips transfer staging before caller %s',
  async (outcome) => {
    const { db, service, backend } = await setup()
    const entered = deferred()
    const release = deferred()
    const caller = db.withTransaction(async (tx) => {
      const ops = service.using(tx)
      await ops.beginFetch(id, {
        contentLength: body.length,
        chunkSize: 1024,
        chunks: [digestOf(body)],
      })
      await ops.stageChunk({ id, index: 0, bytes: body })
      entered.resolve()
      await release.promise
      if (outcome === 'rollback') throw new Error('rollback')
    })
    const settled = caller.then(
      () => 'commit',
      () => 'rollback',
    )
    await entered.promise
    const cutoff = new Date(Date.now() + 10000)
    try {
      expect(await listStaging(backend)).toHaveLength(1)
      expect(await service.pruneStaging(cutoff)).toEqual({ removed: 0, failed: 0 })
    } finally {
      release.resolve()
    }
    expect(await settled).toBe(outcome)
    if (outcome === 'commit')
      expect(await service.pruneStaging(cutoff)).toEqual({ removed: 1, failed: 0 })
    await expect.poll(() => listStaging(backend)).toEqual([])
  },
)

test.each([
  { operation: 'stageChunk', transaction: false },
  { operation: 'stageChunk', transaction: true },
  { operation: 'completeFetch', transaction: false },
  { operation: 'completeFetch', transaction: true },
] as const)(
  '$operation holds the writer during I/O only with transaction=$transaction',
  async ({ operation, transaction }) => {
    const { db, service, gate } = await setup()
    const otherID = (await service.write({ stream: sourceOf(bytesOf(21)).stream })).entry.blobID
    await service.beginFetch(id, {
      contentLength: body.length,
      chunkSize: 1024,
      chunks: [digestOf(body)],
    })
    if (operation === 'completeFetch') await service.stageChunk({ id, index: 0, bytes: body })
    const parked = gate.park(operation === 'stageChunk' ? 'writeChunk' : 'createStagingReadStream')
    const run = (ops: BlobOperations) =>
      operation === 'stageChunk'
        ? ops.stageChunk({ id, index: 0, bytes: body })
        : ops.completeFetch(id)
    const pending = transaction
      ? db.withTransaction(async (tx) => {
          await run(service.using(tx))
        })
      : run(service)
    await parked.entered
    let mutated = false
    const other = service.setPinned(otherID, true).then(() => {
      mutated = true
    })
    try {
      if (transaction) {
        await tick()
        expect(mutated).toBe(false)
      } else {
        await other
        expect(mutated).toBe(true)
      }
    } finally {
      parked.release()
    }
    await pending
    await other
  },
)

test.each(['stageChunk', 'completeFetch'] as const)(
  'a replaced session rejects stale %s work and clears its staging',
  async (operation) => {
    const { service, backend, store, gate } = await setup()
    await service.beginFetch(id, {
      contentLength: body.length,
      chunkSize: 1024,
      chunks: [digestOf(body)],
    })
    if (operation === 'completeFetch') await service.stageChunk({ id, index: 0, bytes: body })
    const original = await store.getTransfer(id)
    const parked = gate.park(operation === 'stageChunk' ? 'writeChunk' : 'createStagingReadStream')
    const pending =
      operation === 'stageChunk'
        ? service.stageChunk({ id, index: 0, bytes: body })
        : service.completeFetch(id)
    const rejected = expect(pending).rejects.toThrow(BlobNotFoundError)
    await parked.entered
    // A different chunk size replaces the session even for a single-chunk body.
    await service.beginFetch(id, {
      contentLength: body.length,
      chunkSize: 2048,
      chunks: [digestOf(body)],
    })
    parked.release()
    await rejected
    expect((await store.getTransfer(id))?.stagingID).not.toBe(original?.stagingID)
    expect(await service.getPresentChunks(id)).toEqual([])
    expect(await listStaging(backend)).toEqual([])
  },
)

test('owned lock transactions retry a deadlock and caller transactions propagate it', async () => {
  const { db, service } = await setup()
  const deadlock = Object.assign(new Error('deadlock'), { code: '40P01' })
  let attempts = 0
  const value = await service.withLocks([id], async () => {
    if (++attempts < 3) throw deadlock
    return 'committed'
  })
  expect(value).toBe('committed')
  expect(attempts).toBe(3)
  attempts = 0
  await expect(
    db.withTransaction(async (tx) => {
      await service.using(tx).withLocks([id], async () => {
        attempts++
        throw deadlock
      })
    }),
  ).rejects.toBe(deadlock)
  expect(attempts).toBe(1)
})

test('a database deadlock before publication retries while a journal drain runs', async () => {
  const { db, service, backend } = await setup()
  await withBlobLocks(db, [id], async (tx) => {
    await (await getBlobStore(tx)).enqueueByteDeletion(id)
  })
  const deleted = deferred()
  const commits = vi.spyOn(backend, 'commit')
  const createAPI = blobStoreDefinition.createAPI
  let attempts = 0
  vi.spyOn(Math, 'random').mockReturnValue(0.99)
  vi.spyOn(blobStoreDefinition, 'createAPI').mockImplementation((query, adapter, context) => {
    const store = createAPI(query, adapter, context)
    return {
      ...store,
      async promoteEntry(entry, chunks) {
        await store.promoteEntry(entry, chunks)
        if (++attempts === 1) {
          context.provider.onRollback(() => {
            void service.drainByteDeletions().then(() => deleted.resolve(), deleted.reject)
          })
          throw Object.assign(new Error('deadlock'), { code: '40P01' })
        }
      },
    }
  })
  const outcome = await service.write(write()).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  )
  await deleted.promise
  expect(outcome).toMatchObject({
    result: { created: true, entry: { blobID: id, state: 'local' } },
  })
  expect(commits).toHaveBeenCalledTimes(1)
  expect(await backend.has(id)).toBe(true)
})

test('a retry with missing staging and bytes rethrows the original deadlock', async () => {
  const { service, backend } = await setup()
  const deadlock = Object.assign(new Error('original database deadlock'), { code: '40P01' })
  const createAPI = blobStoreDefinition.createAPI
  const createStaging = backend.createStaging.bind(backend)
  let stagingID: string | undefined
  vi.spyOn(backend, 'createStaging').mockImplementation(async (id) => {
    stagingID = id
    return await createStaging(id)
  })
  let attempts = 0
  vi.spyOn(blobStoreDefinition, 'createAPI').mockImplementation((query, adapter, context) => {
    const store = createAPI(query, adapter, context)
    return {
      ...store,
      async promoteEntry(entry, chunks) {
        if (++attempts === 1) {
          context.provider.onRollback(() => {
            if (stagingID !== undefined) void backend.abortStaging(stagingID)
          })
          throw deadlock
        }
        await store.promoteEntry(entry, chunks)
      },
    }
  })
  await expect(service.write(write())).rejects.toBe(deadlock)
  expect(await backend.has(id)).toBe(false)
  expect(await service.get(id)).toBeNull()
})

test('writeWith retries its owned transaction after a promotion deadlock', async () => {
  const { service, backend } = await setup()
  const createAPI = blobStoreDefinition.createAPI
  let attempts = 0
  vi.spyOn(blobStoreDefinition, 'createAPI').mockImplementation((query, adapter, context) => {
    const store = createAPI(query, adapter, context)
    return {
      ...store,
      async promoteEntry(entry, chunks) {
        if (++attempts === 1) throw Object.assign(new Error('deadlock'), { code: '40P01' })
        await store.promoteEntry(entry, chunks)
      },
    }
  })
  const result = await service.writeWith({ ...write(), fn: async (_tx, entry) => entry.blobID })
  expect(result.result).toBe(id)
  expect(attempts).toBe(2)
  expect(await backend.has(id)).toBe(true)
  expect(await service.has(id)).toBe(true)
})

test('transaction-bound default services reclaim through their surviving root', async () => {
  const { db, backend, service } = await setup()
  await service.write(write())
  await db.withTransaction(async (tx) => {
    const scoped = createBlobService({ db: tx, backend })
    await scoped.delete(id)
  })
  await expect.poll(() => backend.has(id)).toBe(false)
  await expect(
    db.withTransaction(async (tx) => {
      const scoped = createBlobService({ db: tx, backend })
      await scoped.write(write())
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  await expect.poll(() => backend.has(id)).toBe(false)
  expect(await service.get(id)).toBeNull()
})

test.each(['write', 'completeFetch'] as const)(
  '%s restores metadata when a caller catches publication failure and commits',
  async (operation) => {
    const { db, service, backend, gate, store } = await setup()
    if (operation === 'completeFetch') {
      await service.beginFetch(id, {
        contentLength: body.length,
        chunkSize: 1024,
        chunks: [digestOf(body)],
      })
      await service.stageChunk({ id, index: 0, bytes: body })
    }
    const entryBefore = await service.get(id)
    const transferBefore = await store.getTransfer(id)
    const chunksBefore = await store.getChunkDigests(id)
    const beforeBytes = bytesOf(21)
    const afterBytes = bytesOf(22)
    const beforeID = blake3Codec.encode({ digest: digestOf(beforeBytes), contentLength: 21 })
    const afterID = blake3Codec.encode({ digest: digestOf(afterBytes), contentLength: 22 })
    const failure = new Error('publication unavailable')
    let caught: unknown
    await db.withTransaction(async (tx) => {
      const view = service.using(tx)
      await view.write({ stream: sourceOf(beforeBytes).stream })
      const parked = gate.park('commit')
      const pending = (operation === 'write' ? view.write(write()) : view.completeFetch(id)).catch(
        (error: unknown) => {
          caught = error
        },
      )
      await parked.entered
      parked.fail(failure)
      await pending
      await view.write({ stream: sourceOf(afterBytes).stream })
    })
    expect(caught).toBe(failure)
    expect(await service.get(id)).toEqual(entryBefore)
    expect(await store.getTransfer(id)).toEqual(transferBefore)
    expect(await store.getChunkDigests(id)).toEqual(chunksBefore)
    expect(await backend.has(id)).toBe(false)
    expect(await service.has(beforeID)).toBe(true)
    expect(await service.has(afterID)).toBe(true)
  },
)

test('caller rollback reclaims bytes even if backend commit publishes then rejects', async () => {
  const { db, service, backend } = await setup()
  const commit = backend.commit.bind(backend)
  vi.spyOn(backend, 'commit').mockImplementationOnce(async (stagingID, key) => {
    await commit(stagingID, key)
    throw new Error('publication interrupted')
  })
  await expect(
    db.withTransaction(async (tx) => {
      await service.using(tx).write(write())
    }),
  ).rejects.toThrow('publication interrupted')
  await expect.poll(() => backend.has(id)).toBe(false)
  expect(await service.get(id)).toBeNull()
})

test('fetch promotion deadlocks leave staging intact for retry publication', async () => {
  const { db, service, backend } = await setup()
  await service.beginFetch(id, {
    contentLength: body.length,
    chunkSize: 1024,
    chunks: [digestOf(body)],
  })
  await service.stageChunk({ id, index: 0, bytes: body })
  await withBlobLocks(db, [id], async (tx) => {
    await (await getBlobStore(tx)).enqueueByteDeletion(id)
  })
  const createAPI = blobStoreDefinition.createAPI
  const deleted = deferred()
  const commit = vi.spyOn(backend, 'commit')
  let attempts = 0
  vi.spyOn(blobStoreDefinition, 'createAPI').mockImplementation((query, adapter, context) => {
    const store = createAPI(query, adapter, context)
    return {
      ...store,
      async promoteEntry(entry, chunks) {
        await store.promoteEntry(entry, chunks)
        if (++attempts === 1) {
          context.provider.onRollback(() => {
            void service.drainByteDeletions().then(() => deleted.resolve(), deleted.reject)
          })
          throw Object.assign(new Error('deadlock'), { code: '40P01' })
        }
      },
    }
  })
  expect((await service.completeFetch(id)).state).toBe('local')
  await deleted.promise
  expect(attempts).toBe(2)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(await backend.has(id)).toBe(true)
})

test.each(['stageChunk', 'completeFetch'] as const)(
  'stale %s waits for root staging cleanup before rejecting',
  async (operation) => {
    const { service, backend, gate } = await setup()
    await service.beginFetch(id, {
      contentLength: body.length,
      chunkSize: 1024,
      chunks: [digestOf(body)],
    })
    if (operation === 'completeFetch') await service.stageChunk({ id, index: 0, bytes: body })
    const parked = gate.park(operation === 'stageChunk' ? 'writeChunk' : 'createStagingReadStream')
    const pending =
      operation === 'stageChunk'
        ? service.stageChunk({ id, index: 0, bytes: body })
        : service.completeFetch(id)
    const outcome = pending.catch((error: unknown) => error)
    await parked.entered
    await service.beginFetch(id, {
      contentLength: body.length,
      chunkSize: 2048,
      chunks: [digestOf(body)],
    })
    const abort = backend.abortStaging.bind(backend)
    const cleaned = deferred()
    let removed = false
    vi.spyOn(backend, 'abortStaging').mockImplementationOnce(async (stagingID) => {
      await tick()
      await abort(stagingID)
      removed = true
      cleaned.resolve()
    })
    parked.release()
    const error = await outcome
    try {
      expect(error).toBeInstanceOf(BlobNotFoundError)
      expect(removed).toBe(true)
    } finally {
      await cleaned.promise
    }
  },
)

test('pruning counts a transfer staging cleanup failure', async () => {
  const { service, backend, logError } = await setup()
  await service.beginFetch(id, {
    contentLength: body.length,
    chunkSize: 1024,
    chunks: [digestOf(body)],
  })
  await service.stageChunk({ id, index: 0, bytes: body })
  vi.spyOn(backend, 'abortStaging').mockRejectedValueOnce(new Error('staging unavailable'))
  expect(await service.pruneStaging(new Date(Date.now() + 10000))).toEqual({
    removed: 0,
    failed: 1,
  })
  expect(logError).toHaveBeenCalledOnce()
})

test('savepoint rollback reclaims publication after its parent transaction ends', async () => {
  const { db, service, backend, logError } = await setup()
  await db.withTransaction(async (tx) => {
    if (tx.withSavepoint === undefined) throw new Error('Missing savepoint support')
    await expect(
      tx.withSavepoint(async (savepoint) => {
        await service.using(savepoint).write(write())
        throw new Error('savepoint rollback')
      }),
    ).rejects.toThrow('savepoint rollback')
    expect(await service.using(tx).get(id)).toBeNull()
  })
  await expect.poll(() => backend.has(id)).toBe(false)
  expect(logError).not.toHaveBeenCalled()
})
