import type { StoreDefinition } from '@hozon/db'
import type { StoredLog } from '@hozon/store-log'
import type { StoredSpan } from '@hozon/store-telemetry'
import type { Kysely } from 'kysely'

// biome-ignore lint/suspicious/noExplicitAny: raw access to tables created by the tests.
export type RawDB = Kysely<any>

/** A migration-free store exposing the database's Kysely instance, for raw inspection. */
export const rawStore: StoreDefinition<unknown, RawDB> = {
  name: 'raw',
  migrations: {},
  createAPI: (db) => db as RawDB,
}

export function sampleLog(
  timestamp: number,
  message: string,
  overrides: Partial<StoredLog> = {},
): StoredLog {
  return {
    timestamp,
    level: 'info',
    category: ['app'],
    message,
    properties: {},
    ...overrides,
  }
}

export function tracedLog(timestamp: number, message: string, traceID: string): StoredLog {
  return sampleLog(timestamp, message, { traceID, spanID: `span-${traceID}` })
}

export function sampleSpan(
  traceID: string,
  spanID: string,
  startTime: number,
  overrides: Partial<StoredSpan> = {},
): StoredSpan {
  return {
    traceID,
    spanID,
    name: `span-${spanID}`,
    kind: 0,
    startTime,
    endTime: startTime + 1,
    status: { code: 0 },
    attributes: {},
    events: [],
    links: [],
    ...overrides,
  }
}

/** Names of the base tables in the database, sorted. */
export async function tableNames(db: RawDB): Promise<Array<string>> {
  const tables = await db.introspection.getTables()
  return tables.map((table) => table.name).sort()
}
