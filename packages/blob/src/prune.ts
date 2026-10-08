import { getBlobStore } from '@hozon/store-blob'

import type { WriteContext } from './write.js'

// Removes abandoned staging areas last modified before `olderThan`.
export async function pruneStaging(
  ctx: WriteContext,
  olderThan: Date,
): Promise<{ removed: number }> {
  if (ctx.backend.listStaging === undefined) return { removed: 0 }
  const cutoff = olderThan.getTime()
  const store = await getBlobStore(ctx.db)
  let removed = 0

  // Collect first: aborting while iterating could disturb the backend's listing.
  const old: Array<string> = []
  for await (const area of ctx.backend.listStaging()) {
    if (area.modifiedAt.getTime() < cutoff) old.push(area.stagingID)
  }

  for (const stagingID of old) {
    const session = await store.getTransferByStagingID(stagingID)
    if (session === null) {
      // Write staging IDs are random and never reused, so a flag check is enough.
      // Other processes' writes are protected by the age threshold.
      if (ctx.activeWrites.has(stagingID)) continue
      await ctx.backend.abortStaging(stagingID)
      removed++
      continue
    }
    if (session.updatedAt >= cutoff) continue

    // One lock acquisition per transfer area; the session is re-read under it
    // because a chunk may have been staged since the listing.
    const pruned = await ctx.lock.withLock(session.blobID, async () => {
      const locked = await getBlobStore(ctx.db)
      const current = await locked.getTransfer(session.blobID)
      if (current === null || current.stagingID !== stagingID || current.updatedAt >= cutoff) {
        return false
      }
      await ctx.backend.abortStaging(stagingID)
      await locked.resetTransfer(session.blobID)
      return true
    })
    if (pruned) removed++
  }
  return { removed }
}
