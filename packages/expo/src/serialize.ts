import type { SQLiteBindValue } from 'expo-sqlite'

/** Converts Kysely parameters to values expo-sqlite binds consistently. */
export function serialize(parameters: Array<unknown>): Array<SQLiteBindValue> {
  return parameters.map((parameter): SQLiteBindValue => {
    if (typeof parameter === 'string' || typeof parameter === 'number') {
      return parameter
    }
    if (typeof parameter === 'boolean') {
      // Match AbstractSQLiteAdapter.coerceFilterValue and the other SQLite drivers.
      return parameter ? 1 : 0
    }
    if (parameter === null || parameter === undefined) {
      return null
    }
    if (parameter instanceof Uint8Array) {
      return parameter
    }
    if (parameter instanceof Date) {
      return parameter.toISOString()
    }
    if (typeof parameter === 'object') {
      return JSON.stringify(parameter)
    }
    throw new Error(`Unsupported bind value type: ${typeof parameter}`)
  })
}
