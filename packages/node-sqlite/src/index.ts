import { DatabaseSync } from 'node:sqlite'
import { AbstractSQLiteAdapter } from '@hozon/adapter'
import type { Dialect } from 'kysely'
import { SqliteDialect } from 'kysely'

import type { WrappedDatabase } from './database.js'
import { wrapDatabase } from './database.js'

export type SQLitePragmas = {
  journalMode?: 'wal' | 'delete' | 'truncate' | 'memory' | 'off'
  busyTimeout?: number
  foreignKeys?: boolean
}

export type NodeSQLiteAdapterParams = {
  database: string
  pragmas?: SQLitePragmas
}

export class NodeSQLiteAdapter extends AbstractSQLiteAdapter<{
  Binary: Uint8Array
  JSON: string
  Timestamp: number
}> {
  #database: DatabaseSync
  #wrappedDatabase: WrappedDatabase
  #dialect: Dialect
  #closed = false
  #databaseName: string
  #pragmas: SQLitePragmas

  constructor(params: NodeSQLiteAdapterParams) {
    super()
    this.#databaseName = params.database
    this.#pragmas = params.pragmas ?? {}
    this.#database = new DatabaseSync(params.database)

    try {
      this.#database.exec(`PRAGMA busy_timeout = ${this.#pragmas.busyTimeout ?? 5000}`)
      this.#database.exec(
        `PRAGMA foreign_keys = ${this.#pragmas.foreignKeys === false ? 'OFF' : 'ON'}`,
      )
      this.#wrappedDatabase = wrapDatabase(this.#database)
      this.#dialect = new SqliteDialect({ database: this.#wrappedDatabase })
    } catch (error) {
      this.#database.close()
      this.#closed = true
      throw error
    }
  }

  get database(): DatabaseSync {
    return this.#database
  }

  get dialect(): Dialect {
    return this.#dialect
  }

  async prepare(): Promise<void> {
    if (this.#databaseName === ':memory:' || this.#closed) {
      return
    }

    const journalMode = this.#pragmas.journalMode ?? 'wal'
    this.#database.exec(`PRAGMA journal_mode = ${journalMode}`)
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#wrappedDatabase.close()
  }
}
