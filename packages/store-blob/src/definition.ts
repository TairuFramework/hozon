import type { StoreDefinition, StoreProvider } from '@hozon/db'

import { createBlobStoreAPI } from './api.js'
import { blobStoreMigrations } from './migrations.js'
import type { BlobTables } from './tables.js'
import type { BlobStoreAPI } from './types.js'

export const BLOB_STORE = 'blob'
export const blobStoreDefinition: StoreDefinition<BlobTables, BlobStoreAPI> = {
  name: BLOB_STORE,
  migrations: blobStoreMigrations,
  createAPI: createBlobStoreAPI,
}
export async function getBlobStore(provider: StoreProvider): Promise<BlobStoreAPI> {
  return provider.getStore(BLOB_STORE) as Promise<BlobStoreAPI>
}
