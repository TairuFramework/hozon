import type { BlobEntry, BlobStoreAPI } from '@hozon/store-blob'

// A scope remembers getEntry results; reads made under the blob lock must see the current row.
export async function getFreshEntry(
  store: BlobStoreAPI,
  blobID: string,
): Promise<BlobEntry | null> {
  return (await store.getEntries([blobID])).get(blobID) ?? null
}
