// Adapted from https://github.com/mphill/kysely-expo/blob/main/src/driver.ts
// Copyright (c) 2023 mphill, MIT License. See ../THIRD_PARTY_NOTICES.md for the full notice.
import type { WritePriority } from '@hozon/adapter'
import type { SQLiteDatabase } from 'expo-sqlite'
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'

import { serialize } from './serialize.js'

export type ExpoDialectParams = {
  /** Open expo-sqlite database handle, owned by the caller. */
  database: SQLiteDatabase
  /** Called when Kysely destroys the driver; closes the handle. */
  destroy: () => Promise<void>
  priority?: WritePriority
  mutex?: ConnectionMutex
}

class ExpoDialectAdapter extends SqliteAdapter {
  // The mutex owns admission. Kysely must not hide waiting requests in another queue.
  override get supportsMultipleConnections(): boolean {
    return true
  }
}

/** Kysely dialect over an expo-sqlite database handle. */
export class ExpoDialect implements Dialect {
  #params: ExpoDialectParams

  constructor(params: ExpoDialectParams) {
    this.#params = params
  }

  createDriver(): Driver {
    return new ExpoDriver(this.#params)
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }

  createAdapter(): DialectAdapter {
    return new ExpoDialectAdapter()
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}

/** Kysely driver serialising every query through the single expo-sqlite connection. */
export class ExpoDriver implements Driver {
  #connectionMutex: ConnectionMutex
  #priority: WritePriority
  #connection: ExpoConnection
  #destroy: () => Promise<void>

  constructor(params: ExpoDialectParams) {
    this.#connectionMutex = params.mutex ?? new ConnectionMutex()
    this.#priority = params.priority ?? 'high'
    this.#connection = new ExpoConnection(params.database)
    this.#destroy = params.destroy
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#connectionMutex.lock(this.#priority)
    return this.#connection
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as ExpoConnection).directQuery('begin transaction')
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as ExpoConnection).directQuery('commit')
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as ExpoConnection).directQuery('rollback')
  }

  async releaseConnection(): Promise<void> {
    this.#connectionMutex.unlock()
  }

  async destroy(): Promise<void> {
    // Wait for the holder: closing mid-transaction would leave it to fail on a closed handle.
    await this.#connectionMutex.lock()
    try {
      await this.#destroy()
    } finally {
      this.#connectionMutex.unlock()
    }
  }
}

class ExpoConnection implements DatabaseConnection {
  #database: SQLiteDatabase

  constructor(database: SQLiteDatabase) {
    this.#database = database
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters, query } = compiledQuery
    const bindValues = serialize([...parameters])

    const readonly = query.kind === 'SelectQueryNode' || query.kind === 'RawNode'
    if (readonly || sql.includes(' returning ')) {
      const rows = await this.#database.getAllAsync<R>(sql, bindValues)
      return { rows }
    }

    const result = await this.#database.runAsync(sql, bindValues)
    return {
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowId),
      rows: [],
    }
  }

  async directQuery<T>(query: string): Promise<Array<T>> {
    return await this.#database.getAllAsync<T>(query, [])
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Expo SQLite driver does not support streaming queries')
  }
}

/** FIFO per priority. After eight high grants, a waiting low gets one turn. */
export class ConnectionMutex {
  #held = false
  #highGrants = 0
  #high: Array<() => void> = []
  #low: Array<() => void> = []

  async lock(priority: WritePriority = 'high'): Promise<void> {
    if (!this.#held) {
      this.#held = true
      this.#highGrants = priority === 'high' ? 1 : 0
      return
    }
    await new Promise<void>((resolve) => {
      ;(priority === 'high' ? this.#high : this.#low).push(resolve)
    })
  }

  unlock(): void {
    const low = this.#low.length > 0 && (this.#high.length === 0 || this.#highGrants >= 8)
    const next = (low ? this.#low : this.#high).shift()
    if (next) {
      this.#highGrants = low ? 0 : this.#highGrants + 1
      next()
    } else {
      this.#held = false
      this.#highGrants = 0
    }
  }
}
