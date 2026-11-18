import type { NativeDBHandle, NativeSQLite, TxID } from '@hozon/adapter'
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

export type NativeDialectParams = {
  sqlite: NativeSQLite
  database: Promise<NativeDBHandle>
  destroy: () => Promise<void>
  /** Optional JS wait bound. A native grant arriving after expiry is abandoned. */
  admissionTimeoutMs?: number
}

class NativeDialectAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true
  }
}

export class NativeDialect implements Dialect {
  #params: NativeDialectParams
  constructor(params: NativeDialectParams) {
    this.#params = params
  }
  createDriver(): Driver {
    return new NativeDriver(this.#params)
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }
  createAdapter(): DialectAdapter {
    return new NativeDialectAdapter()
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}

export class NativeDriver implements Driver {
  #params: NativeDialectParams
  constructor(params: NativeDialectParams) {
    this.#params = params
  }
  async init(): Promise<void> {
    await this.#params.database
  }
  async acquireConnection(): Promise<DatabaseConnection> {
    return new NativeConnection(this.#params.sqlite, await this.#params.database)
  }
  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    const native = connection as NativeConnection
    const timeoutMs = this.#params.admissionTimeoutMs
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const admission = this.#params.sqlite
      .beginWrite(await this.#params.database, timeoutMs === undefined ? undefined : { timeoutMs })
      .then(async (grant) => {
        if (expired) {
          await this.#params.sqlite.abandon(await this.#params.database, grant.admissionID)
          throw new Error('Native admission wait expired after grant')
        }
        return grant
      })
    try {
      const grant =
        timeoutMs === undefined
          ? await admission
          : await Promise.race([
              admission,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  expired = true
                  reject(new Error('Native admission wait expired'))
                }, timeoutMs)
              }),
            ])
      native.txID = grant.txID
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const native = connection as NativeConnection
    if (native.txID === null) throw new Error('No active native transaction')
    await this.#params.sqlite.commit(native.database, native.txID)
    native.txID = null
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const native = connection as NativeConnection
    if (native.txID === null) throw new Error('No active native transaction')
    await this.#params.sqlite.rollback(native.database, native.txID)
    native.txID = null
  }
  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    const native = connection as NativeConnection
    if (native.txID !== null) await this.rollbackTransaction(native)
  }
  async destroy(): Promise<void> {
    await this.#params.destroy()
  }
}

/** Ignore comments and quoted text when classifying raw statements and CTEs. */
export function queryMode(compiled: CompiledQuery): 'read' | 'write' {
  if (compiled.query.kind === 'SelectQueryNode') return 'read'
  if (compiled.query.kind !== 'RawNode') return 'write'
  const text = compiled.sql.replace(
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
    ' ',
  )
  const tokens: Array<string> = text.toUpperCase().match(/[A-Z_]+|[()=]/g) ?? []
  const first = tokens[0]
  if (first === 'SELECT' || first === 'VALUES') return 'read'
  if (first === 'EXPLAIN')
    return tokens.some((token) => ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(token))
      ? 'write'
      : 'read'
  if (first === 'WITH') {
    let depth = 0
    for (const token of tokens.slice(1)) {
      if (token === '(') depth++
      else if (token === ')') depth--
      else if (depth === 0 && token === 'SELECT') return 'read'
      else if (depth === 0 && ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(token))
        return 'write'
    }
    return 'write'
  }
  if (first === 'PRAGMA') {
    if (tokens.includes('=')) return 'write'
    const name = tokens[tokens[1] === 'MAIN' || tokens[1] === 'TEMP' ? 2 : 1]
    const commands = ['WAL_CHECKPOINT', 'OPTIMIZE', 'INCREMENTAL_VACUUM', 'SHRINK_MEMORY']
    if (commands.includes(name ?? '')) return 'write'
    const readArguments = [
      'TABLE_INFO',
      'TABLE_XINFO',
      'INDEX_INFO',
      'INDEX_XINFO',
      'INDEX_LIST',
      'FOREIGN_KEY_LIST',
      'INTEGRITY_CHECK',
      'QUICK_CHECK',
      'FOREIGN_KEY_CHECK',
    ]
    return !tokens.includes('(') || readArguments.includes(name ?? '') ? 'read' : 'write'
  }
  return 'write'
}

class NativeConnection implements DatabaseConnection {
  txID: TxID | null = null
  #sqlite: NativeSQLite
  #database: NativeDBHandle
  constructor(sqlite: NativeSQLite, database: NativeDBHandle) {
    this.#sqlite = sqlite
    this.#database = database
  }
  get database(): NativeDBHandle {
    return this.#database
  }
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const mode = queryMode(compiled)
    const result = await this.#sqlite.execute(
      this.database,
      this.txID,
      compiled.sql,
      serialize([...compiled.parameters]),
      mode,
    )
    const rows = result.rows.map(
      (values) =>
        Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as R,
    )
    return mode === 'read'
      ? { rows }
      : { rows, numAffectedRows: result.changes, insertId: result.lastInsertRowID }
  }
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Native SQLite driver does not support streaming queries')
  }
}
