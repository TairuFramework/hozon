import { getBlobStore } from '@hozon/store-blob'

import { lockBlobs } from './locking.js'
import { afterCommit } from './manage.js'
import type { WriteContext } from './write.js'

// Removes abandoned staging areas last modified before `olderThan`. Only areas
// with this service's `w-` and `t-` ID prefixes are considered. A failure on one
// area is counted in `failed` and does not stop the others.
export async function pruneStaging(
  ctx: WriteContext,
  olderThan: Date,
): Promise<{ removed: number; failed: number }> {
  const cutoff = olderThan.getTime()
  const store = await getBlobStore(ctx.db)
  let removed = 0
  let failed = 0

  // Collect first: aborting while iterating could disturb the backend's listing.
  const old: Array<string> = []
  const existing = new Set<string>()
  for await (const area of ctx.backend.listStaging?.() ?? []) {
    existing.add(area.stagingID)
    if (!isOwnedStagingID(area.stagingID)) continue
    if (area.modifiedAt.getTime() < cutoff) old.push(area.stagingID)
  }

  for (const stagingID of old) {
    try {
      if (ctx.activeWrites.has(stagingID)) continue
      const session = await store.getSessionByStagingID(stagingID)
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
      let cleanup: Promise<boolean> | undefined
      const pruned = await lockBlobs(ctx.db, [session.blobID], async (tx) => {
        const locked = await getBlobStore(tx)
        const current = await locked.getSession(session.blobID, session.owner)
        if (current === null || current.stagingID !== stagingID || current.updatedAt >= cutoff) {
          return false
        }
        await locked.deleteSession(session.blobID, session.owner)
        cleanup = afterCommit(ctx, tx, () => ctx.backend.abortStaging(stagingID))
        return true
      })
      if (!ctx.db.isTransactionBound && (await cleanup) === false) {
        failed++
        continue
      }
      if (pruned) removed++
    } catch {
      failed++
    }
  }
  // Lazy staging creation and vanished areas must not leave sessions holding blobs forever.
  let cursor: string | undefined
  do {
    const page = await store.listSessions({ limit: 500, cursor })
    for (const session of page.sessions) {
      if (
        existing.has(session.stagingID) ||
        ctx.activeWrites.has(session.stagingID) ||
        session.updatedAt >= cutoff
      )
        continue
      try {
        let cleanup: Promise<boolean> | undefined
        const pruned = await lockBlobs(ctx.db, [session.blobID], async (tx) => {
          const locked = await getBlobStore(tx)
          const current = await locked.getSession(session.blobID, session.owner)
          if (
            current === null ||
            current.stagingID !== session.stagingID ||
            current.updatedAt >= cutoff ||
            ctx.activeWrites.has(current.stagingID)
          )
            return false
          await locked.deleteSession(current.blobID, current.owner)
          cleanup = afterCommit(ctx, tx, () => ctx.backend.abortStaging(current.stagingID))
          return true
        })
        if (!ctx.db.isTransactionBound && (await cleanup) === false) failed++
        else if (pruned) removed++
      } catch {
        failed++
      }
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return { removed, failed }
}

function isOwnedStagingID(stagingID: string): boolean {
  return stagingID.startsWith('w-') || stagingID.startsWith('t-')
}
