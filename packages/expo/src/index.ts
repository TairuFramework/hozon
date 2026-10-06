import { AbstractSQLiteAdapter } from '@hozon/adapter'
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite'
import type { Dialect } from 'kysely'

import { ExpoDialect } from './driver.js'

export type ExpoAdapterParams = {
  /** expo-sqlite database name, for example `hozon.db`. */
  database: string
}

export class ExpoAdapter extends AbstractSQLiteAdapter<{
  Binary: Uint8Array
  JSON: string
  Timestamp: number
}> {
  #database: SQLiteDatabase
  #dialect: Dialect
  #closing: Promise<void> | undefined

  constructor(params: ExpoAdapterParams) {
    super()
    this.#database = openDatabaseSync(params.database)
    try {
      this.#database.execSync('PRAGMA foreign_keys = ON')
    } catch (error) {
      this.#database.closeSync()
      throw error
    }
    // The adapter owns the handle: Kysely destroying its driver and HozonDB closing the
    // adapter both route through the single idempotent close().
    this.#dialect = new ExpoDialect({ database: this.#database, destroy: () => this.close() })
  }

  get database(): SQLiteDatabase {
    return this.#database
  }

  get dialect(): Dialect {
    return this.#dialect
  }

  close(): Promise<void> {
    this.#closing ??= this.#database.closeAsync()
    return this.#closing
  }
}
