import type { StoreDefinition, StoreProvider } from '@hozon/db'

import { createLogStoreAPI } from './api.js'
import { logStoreMigrations } from './migrations.js'
import type { LogTables } from './tables.js'
import type { LogStore } from './types.js'

export const LOG_STORE = 'log'
export const logStoreDefinition: StoreDefinition<LogTables, LogStore> = {
  name: LOG_STORE,
  migrations: logStoreMigrations,
  createAPI: createLogStoreAPI,
}
export async function getLogStore(provider: StoreProvider): Promise<LogStore> {
  return provider.getStore(LOG_STORE) as Promise<LogStore>
}
