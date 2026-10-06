import type { StoreDefinition, StoreProvider } from '@hozon/db'

import { createTelemetryStoreAPI } from './api.js'
import { telemetryStoreMigrations } from './migrations.js'
import type { TelemetryTables } from './tables.js'
import type { TelemetryStore } from './types.js'

export const TELEMETRY_STORE = 'telemetry'
export const telemetryStoreDefinition: StoreDefinition<TelemetryTables, TelemetryStore> = {
  name: TELEMETRY_STORE,
  migrations: telemetryStoreMigrations,
  createAPI: createTelemetryStoreAPI,
}
export async function getTelemetryStore(provider: StoreProvider): Promise<TelemetryStore> {
  return provider.getStore(TELEMETRY_STORE) as Promise<TelemetryStore>
}
