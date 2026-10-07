// Adapted from https://github.com/mphill/kysely-expo/blob/main/src/driver.ts
// Copyright (c) 2023 mphill, MIT License. See ../THIRD_PARTY_NOTICES.md for the full notice.
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
    return new SqliteAdapter()
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}

/** Kysely driver serialising every query through the single expo-sqlite connection. */
export class ExpoDriver implements Driver {
  #connectionMutex = new ConnectionMutex()
  #connection: ExpoConnection
  #destroy: () => Promise<void>

  constructor(params: ExpoDialectParams) {
    this.#connection = new ExpoConnection(params.database)
    this.#destroy = params.destroy
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#connectionMutex.lock()
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
    await this.#destroy()
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

class ConnectionMutex {
  #promise?: Promise<void>
  #resolve?: () => void

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise
    }
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve
    })
  }

  unlock(): void {
    const resolve = this.#resolve
    this.#promise = undefined
    this.#resolve = undefined
    resolve?.()
  }
}
