import { assertBatchSize, type StoreProvider, withKeyLocks } from '@hozon/db'

export const BLOB_LOCK_TABLE = 'blob_entries'

// The callback must use its lock-scoped provider.
export async function withBlobLocks<R>(
  provider: StoreProvider,
  blobIDs: Array<string>,
  fn: (tx: StoreProvider) => Promise<R>,
): Promise<R> {
  assertBatchSize(blobIDs.length, 500)
  return await withKeyLocks(
    provider,
    BLOB_LOCK_TABLE,
    blobIDs.map((id) => [id]),
    fn,
  )
}
