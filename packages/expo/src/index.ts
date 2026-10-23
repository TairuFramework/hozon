import { AbstractSQLiteAdapter } from '@hozon/adapter'
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite'
import type { Dialect } from 'kysely'

import { ExpoDialect } from './driver.js'
import { applyEncryptionKey } from './encryption.js'

export type ExpoAdapterParams = {
  /** expo-sqlite database name, for example `hozon.db`. */
  database: string
  /**
   * Raw 32-byte SQLCipher key. Requires `useSQLCipher: true` in the expo-sqlite config
   * plugin. Store it outside the database, for example in `expo-secure-store`.
   */
  encryptionKey?: Uint8Array
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
      if (params.encryptionKey != null) {
        applyEncryptionKey(this.#database, params.encryptionKey)
      }
      this.#database.execSync('PRAGMA foreign_keys = ON')
      const fts = this.#database.getFirstSync<{ enabled: number }>(
        "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled",
      )
      if (fts?.enabled !== 1) this.search = undefined
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
