import type { BlobBackend, MemoryBlobBackend } from '@hozon/blob-backend'
import { blake3Codec } from '@hozon/blob-id'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { BlobReconcileUnsupportedError } from '../src/index.js'
import { deferred, gatedBackend } from './gated-backend.js'
import { bytesOf, createTestService, digestOf, sourceOf } from './helpers.js'

let ctx: Awaited<ReturnType<typeof createTestService>>
const body = bytesOf(20)
const id = blake3Codec.encode({ digest: digestOf(body), contentLength: body.length })
const future = () => new Date(Date.now() + 1000)
beforeEach(async () => {
  ctx = await createTestService({ logger: { error: vi.fn() } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.db.close()
})
async function orphan(key: string) {
  await ctx.backend.writeChunk('w-orphan', 0, body)
  await ctx.backend.commit('w-orphan', key)
}

test('reconciliation removes old orphans, retaining newer, local and undecodable keys', async () => {
  await orphan(id)
  await orphan('not-a-blob-id')
  expect(await ctx.service.reconcileBytes({ olderThan: new Date(0) })).toEqual({
    scanned: 0,
    deleted: 0,
    failed: 0,
  })
  expect(await ctx.service.reconcileBytes({ olderThan: future() })).toEqual({
    scanned: 1,
    deleted: 1,
    failed: 0,
  })
  expect(await ctx.backend.has('not-a-blob-id')).toBe(true)
  await ctx.service.write({ stream: sourceOf(body).stream })
  expect(await ctx.service.reconcileBytes({ olderThan: future() })).toEqual({
    scanned: 1,
    deleted: 0,
    failed: 0,
  })
  expect(await ctx.backend.has(id)).toBe(true)
})

test('reconciliation waits for an uncommitted writer and keeps its local bytes', async () => {
  const written = deferred()
  const release = deferred()
  const caller = ctx.db.withTransaction(async (tx) => {
    await ctx.service.using(tx).write({ stream: sourceOf(body).stream })
    written.resolve()
    await release.promise
  })
  await written.promise
  const reconciling = ctx.service.reconcileBytes({ olderThan: future() })
  release.resolve()
  await caller
  expect(await reconciling).toEqual({ scanned: 1, deleted: 0, failed: 0 })
  expect(await ctx.backend.has(id)).toBe(true)
})

test('reconciliation handles orphan publication after simulated lost row commit and per-key failure', async () => {
  await orphan(id)
  const remove = vi.spyOn(ctx.backend, 'delete').mockRejectedValueOnce(new Error('unlink'))
  expect(await ctx.service.reconcileBytes({ olderThan: future(), limit: 1 })).toEqual({
    scanned: 1,
    deleted: 0,
    failed: 1,
  })
  remove.mockRestore()
  expect(await ctx.service.reconcileBytes({ olderThan: future(), limit: 1 })).toEqual({
    scanned: 1,
    deleted: 1,
    failed: 0,
  })
})

test('unsupported reconciliation throws, and maintenance without bytesOlderThan skips it', async () => {
  await ctx.db.close()
  const { backend } = gatedBackend()
  const withoutListing: BlobBackend = { ...backend, listKeys: undefined }
  ctx = await createTestService({ backend: withoutListing, logger: { error: vi.fn() } })
  await expect(ctx.service.reconcileBytes({ olderThan: future() })).rejects.toBeInstanceOf(
    BlobReconcileUnsupportedError,
  )
  const result = await ctx.service.runMaintenance({ grace: 0, stagingOlderThan: 0 })
  expect(result.reconciled).toBeNull()
  expect(result.collected).toEqual({ deleted: 0, kept: 0, failed: 0 })
})

test('maintenance runs drain, prune, collect and reconcile in order and reports each', async () => {
  const calls: Array<string> = []
  vi.spyOn(ctx.store, 'listByteDeletions').mockImplementation(async () => {
    calls.push('drain')
    return []
  })
  vi.spyOn(ctx.backend, 'listStaging').mockImplementation(async function* () {
    calls.push('prune')
    yield* []
  })
  vi.spyOn(ctx.store, 'listReleases').mockImplementation(async () => {
    calls.push('collect')
    return []
  })
  vi.spyOn(ctx.backend, 'listKeys').mockImplementation(async function* () {
    calls.push('reconcile')
    yield* []
  })
  const result = await ctx.service.runMaintenance({
    grace: 0,
    stagingOlderThan: 0,
    bytesOlderThan: 0,
  })
  expect(calls).toEqual(['drain', 'prune', 'drain', 'collect', 'reconcile'])
  expect(result).toEqual({
    drained: { deleted: 0, failed: 0 },
    pruned: { removed: 0, failed: 0 },
    collected: { deleted: 0, kept: 0, failed: 0 },
    reconciled: { scanned: 0, deleted: 0, failed: 0 },
  })
})

test.each(['drain', 'prune', 'collect', 'reconcile'])(
  'maintenance logs a failing %s step and continues',
  async (step) => {
    const calls: Array<string> = []
    vi.spyOn(ctx.store, 'listByteDeletions').mockImplementation(async () => {
      calls.push('drain')
      if (step === 'drain') throw new Error(step)
      return []
    })
    vi.spyOn(ctx.backend, 'listStaging').mockImplementation(async function* () {
      calls.push('prune')
      yield* []
      if (step === 'prune') throw new Error(step)
    })
    vi.spyOn(ctx.store, 'listReleases').mockImplementation(async () => {
      calls.push('collect')
      if (step === 'collect') throw new Error(step)
      return []
    })
    vi.spyOn(ctx.backend, 'listKeys').mockImplementation(async function* () {
      calls.push('reconcile')
      yield* []
      if (step === 'reconcile') throw new Error(step)
    })
    const result = await ctx.service.runMaintenance({
      grace: 0,
      stagingOlderThan: 0,
      bytesOlderThan: 0,
    })
    expect(calls).toContain('prune')
    expect(calls.at(-1)).toBe('reconcile')
    expect(result).toHaveProperty('collected')
    expect(result.reconciled?.failed).toBe(step === 'reconcile' ? 1 : 0)
  },
)

test('reconciliation limit bounds eligible keys and validates input', async () => {
  const memory = ctx.backend as MemoryBlobBackend
  await orphan(id)
  const other = blake3Codec.encode({ digest: digestOf(bytesOf(21)), contentLength: 21 })
  await orphan(other)
  expect((await ctx.service.reconcileBytes({ olderThan: future(), limit: 1 })).scanned).toBe(1)
  expect((await ctx.service.reconcileBytes({ olderThan: future() })).deleted).toBe(1)
  expect(await memory.has(id)).toBe(false)
  await expect(ctx.service.reconcileBytes({ olderThan: future(), limit: 0 })).rejects.toThrow()
  await expect(ctx.service.collect({ releasedBefore: future(), limit: 501 })).rejects.toThrow()
  await expect(ctx.service.reconcileBytes({ olderThan: future(), limit: 501 })).resolves.toEqual({
    scanned: 0,
    deleted: 0,
    failed: 0,
  })
})

test('retained local keys do not prevent a limited reconciliation reaching orphan keys', async () => {
  await ctx.service.write({ stream: sourceOf(body).stream })
  const other = blake3Codec.encode({ digest: digestOf(bytesOf(21)), contentLength: 21 })
  await orphan(other)
  expect(await ctx.service.reconcileBytes({ olderThan: future(), limit: 1 })).toEqual({
    scanned: 2,
    deleted: 1,
    failed: 0,
  })
  expect(await ctx.backend.has(id)).toBe(true)
  expect(await ctx.backend.has(other)).toBe(false)
})
