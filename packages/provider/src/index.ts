import type { Adapter } from '@hozon/adapter'
import type { HozonDBParams } from '@hozon/db'
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { PostgresAdapter } from '@hozon/postgres'

export type { Adapter } from '@hozon/adapter'
export type AdapterInput = Adapter | string
export type HozonDBInput = HozonDB | AdapterInput

export function resolveAdapter(input: AdapterInput): Adapter {
  if (typeof input !== 'string') {
    return input
  }
  if (input === ':memory:') {
    return new NodeSQLiteAdapter({ database: ':memory:' })
  }
  if (input.startsWith('postgres://') || input.startsWith('postgresql://')) {
    return new PostgresAdapter({ url: input })
  }
  return new NodeSQLiteAdapter({ database: input })
}

export function resolveDB(
  input: HozonDBInput,
  params: Omit<HozonDBParams, 'adapter'> = {},
): HozonDB {
  if (input instanceof HozonDB) {
    return input
  }
  return new HozonDB({ ...params, adapter: resolveAdapter(input) })
}
