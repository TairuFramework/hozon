import type { BlobBackend, BlobLock } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import { getBlobStore } from '@hozon/store-blob'

import { BlobNotFoundError } from './errors.js'

export type ManageContext = {
  db: StoreProvider
  backend: BlobBackend
  codec: BlobIDCodec
  lock: BlobLock
}

export async function setBlobPinned(
  ctx: ManageContext,
  id: string,
  pinned: boolean,
): Promise<void> {
  const blobID = ctx.codec.canonicalize(id)
  await ctx.lock.withLock(blobID, async () => {
    const store = await getBlobStore(ctx.db)
    if ((await store.getEntry(blobID)) === null) throw new BlobNotFoundError(blobID)
    await store.setPinned(blobID, pinned)
  })
}

export async function deleteBlob(ctx: ManageContext, id: string): Promise<boolean> {
  const blobID = ctx.codec.canonicalize(id)
  return await ctx.lock.withLock(blobID, async () => {
    const store = await getBlobStore(ctx.db)
    const entry = await store.getEntry(blobID)
    if (entry === null) return false
    const transfer = entry.state === 'partial' ? await store.getTransfer(blobID) : null
    // The row goes first: a crash then leaves orphaned bytes, never a row without bytes.
    await store.deleteEntry(blobID)
    if (transfer !== null) {
      try {
        await ctx.backend.abortStaging(transfer.stagingID)
      } catch {
        // Reclaimed by staging pruning.
      }
    }
    if (entry.state === 'local') await ctx.backend.delete(blobID)
    return true
  })
}
