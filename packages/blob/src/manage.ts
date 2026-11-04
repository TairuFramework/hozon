import type { BlobBackend } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import { getBlobStore } from '@hozon/store-blob'

import { BlobNotFoundError } from './errors.js'
import { getFreshEntry } from './fresh.js'
import { lockBlobs } from './locking.js'

export type ManageContext = {
  db: StoreProvider
  root: StoreProvider
  backend: BlobBackend
  codec: BlobIDCodec
  logError(error: unknown): void
}

export function afterCommit(
  ctx: ManageContext,
  tx: StoreProvider,
  fn: () => Promise<void>,
): Promise<boolean> {
  return new Promise((resolve) => {
    tx.onCommit(() => {
      void fn().then(
        () => resolve(true),
        (error: unknown) => {
          ctx.logError(error)
          resolve(false)
        },
      )
    })
    tx.onRollback(() => resolve(false))
  })
}

export function reclaimOnRollback(ctx: ManageContext, tx: StoreProvider, blobID: string): void {
  const outer = tx.transactionRoot ?? tx
  let rolledBack = false
  const run = () => {
    void reclaim(ctx, blobID).catch(ctx.logError)
  }
  tx.onRollback(() => {
    rolledBack = true
  })
  // A savepoint rollback must wait until its parent releases the connection.
  outer.onCommit(() => {
    if (rolledBack) run()
  })
  outer.onRollback(run)
}

export async function reclaim(ctx: ManageContext, blobID: string): Promise<void> {
  await lockBlobs(ctx.root, [blobID], async (tx) => {
    const store = await getBlobStore(tx)
    if ((await getFreshEntry(store, blobID))?.state !== 'local') await ctx.backend.delete(blobID)
  })
}

export async function deleteBytes(ctx: ManageContext, blobID: string): Promise<void> {
  await lockBlobs(ctx.root, [blobID], async (tx) => {
    const store = await getBlobStore(tx)
    // A publisher can clear the journal while this worker waits for the lock.
    if ((await getFreshEntry(store, blobID))?.state !== 'local') await ctx.backend.delete(blobID)
    await store.deleteByteDeletion(blobID)
  })
}

export async function drainByteDeletions(
  ctx: ManageContext,
  params?: { limit?: number },
): Promise<{ deleted: number; failed: number }> {
  const rows = await (await getBlobStore(ctx.root)).listByteDeletions(params)
  let deleted = 0
  let failed = 0
  for (const { blobID } of rows) {
    try {
      await deleteBytes(ctx, blobID)
      deleted++
    } catch (error) {
      ctx.logError(error)
      failed++
    }
  }
  return { deleted, failed }
}

export async function setBlobPinned(
  ctx: ManageContext,
  id: string,
  pinned: boolean,
): Promise<void> {
  const blobID = ctx.codec.canonicalize(id)
  await lockBlobs(ctx.db, [blobID], async (tx) => {
    const store = await getBlobStore(tx)
    if ((await getFreshEntry(store, blobID)) === null) throw new BlobNotFoundError(blobID)
    await store.setPinned(blobID, pinned)
  })
}

export async function deleteBlob(ctx: ManageContext, id: string): Promise<boolean> {
  const blobID = ctx.codec.canonicalize(id)
  let cleanup: Promise<boolean> | undefined
  const result = await lockBlobs(ctx.db, [blobID], async (tx) => {
    const store = await getBlobStore(tx)
    const entry = await getFreshEntry(store, blobID)
    if (entry === null) return null
    const transfer = await store.getTransfer(blobID)
    await store.deleteEntry(blobID)
    if (entry.state === 'local') await store.enqueueByteDeletion(blobID)
    if (transfer !== null)
      cleanup = afterCommit(ctx, tx, () => ctx.backend.abortStaging(transfer.stagingID))
    if (entry.state === 'local' && ctx.db.isTransactionBound) {
      afterCommit(ctx, tx, () => deleteBytes(ctx, blobID))
    }
    return entry.state
  })
  if (!ctx.db.isTransactionBound) await cleanup
  if (result === null) return false
  if (result === 'local' && !ctx.db.isTransactionBound) await deleteBytes(ctx, blobID)
  return true
}
