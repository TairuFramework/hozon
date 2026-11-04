import { assertBatchSize } from '@hozon/db'
import { getBlobStore } from '@hozon/store-blob'

import { BlobReconcileUnsupportedError } from './errors.js'
import { getFreshEntry } from './fresh.js'
import { lockBlobs } from './locking.js'
import { deleteBytes, drainByteDeletions } from './manage.js'
import { pruneStaging } from './prune.js'
import type { WriteContext } from './write.js'

export type CollectParams = { releasedBefore: Date; limit?: number }
export type CollectResult = { deleted: number; kept: number; failed: number }
export type ReconcileParams = { olderThan: Date; limit?: number }
export type ReconcileResult = { scanned: number; deleted: number; failed: number }
export type MaintenanceParams = {
  grace: number
  stagingOlderThan: number
  bytesOlderThan?: number
  limit?: number
}
export type MaintenanceResult = {
  drained: { deleted: number; failed: number }
  pruned: { removed: number; failed: number }
  collected: CollectResult
  reconciled: ReconcileResult | null
}

function validateLimit(limit: number, max?: number): void {
  if (max !== undefined) assertBatchSize(limit, max)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid limit')
}

export async function collect(
  ctx: WriteContext,
  { releasedBefore, limit = 100 }: CollectParams,
): Promise<CollectResult> {
  validateLimit(limit, 500)
  await drainByteDeletions(ctx)
  const rows = await (await getBlobStore(ctx.root)).listReleases({ releasedBefore, limit })
  const result = { deleted: 0, kept: 0, failed: 0 }
  for (const { blobID } of rows) {
    try {
      const decision = await lockBlobs(ctx.root, [blobID], async (tx) => {
        const store = await getBlobStore(tx)
        // Serialise lock-free ref removals before deciding from their committed refs.
        const released = await store.listReleases({
          releasedBefore,
          blobID,
          limit: 1,
          forUpdate: true,
        })
        if (released.length === 0) return 'skip'
        const entry = await getFreshEntry(store, blobID)
        const refs = await store.countRefs(blobID)
        const session = (await store.listSessions({ blobID, limit: 1 })).sessions[0] ?? null
        if (refs > 0 || entry?.pinned || session !== null) {
          await store.deleteRelease(blobID)
          return 'kept'
        }
        if (entry === null) {
          await store.deleteRelease(blobID)
          return 'skip'
        }
        await store.deleteEntry(blobID)
        if (entry.state === 'local') await store.enqueueByteDeletion(blobID)
        return entry.state === 'local' ? 'bytes' : 'deleted'
      })
      if (decision === 'bytes') await deleteBytes(ctx, blobID)
      if (decision === 'bytes' || decision === 'deleted') result.deleted++
      else if (decision === 'kept') result.kept++
    } catch (error) {
      ctx.logError(error)
      result.failed++
    }
  }
  return result
}

export async function reconcileBytes(
  ctx: WriteContext,
  { olderThan, limit = 100 }: ReconcileParams,
): Promise<ReconcileResult> {
  if (ctx.backend.listKeys === undefined) throw new BlobReconcileUnsupportedError()
  validateLimit(limit)
  const result = { scanned: 0, deleted: 0, failed: 0 }
  for await (const { key, modifiedAt } of ctx.backend.listKeys()) {
    if (modifiedAt.getTime() >= olderThan.getTime()) continue
    let blobID: string
    try {
      blobID = ctx.codec.canonicalize(key)
    } catch {
      continue
    }
    result.scanned++
    try {
      const removed = await lockBlobs(ctx.root, [blobID], async (tx) => {
        const store = await getBlobStore(tx)
        if ((await getFreshEntry(store, blobID))?.state === 'local') return false
        await ctx.backend.delete(key)
        return true
      })
      if (removed) result.deleted++
    } catch (error) {
      ctx.logError(error)
      result.failed++
    }
    if (result.deleted + result.failed >= limit) break
  }
  return result
}

export async function runMaintenance(
  ctx: WriteContext,
  params: MaintenanceParams,
): Promise<MaintenanceResult> {
  const now = Date.now()
  async function step<T>(run: () => Promise<T>, failed: T): Promise<T> {
    try {
      return await run()
    } catch (error) {
      ctx.logError(error)
      return failed
    }
  }
  const drained = await step(() => drainByteDeletions(ctx, { limit: params.limit }), {
    deleted: 0,
    failed: 1,
  })
  const pruned = await step(() => pruneStaging(ctx, new Date(now - params.stagingOlderThan)), {
    removed: 0,
    failed: 1,
  })
  const collected = await step(
    () => collect(ctx, { releasedBefore: new Date(now - params.grace), limit: params.limit }),
    { deleted: 0, kept: 0, failed: 1 },
  )
  const reconciled =
    params.bytesOlderThan === undefined
      ? null
      : await step(
          () =>
            reconcileBytes(ctx, {
              olderThan: new Date(now - (params.bytesOlderThan as number)),
              limit: params.limit,
            }),
          { scanned: 0, deleted: 0, failed: 1 },
        )
  return { drained, pruned, collected, reconciled }
}
