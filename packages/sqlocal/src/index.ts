import { AbstractSQLiteAdapter } from '@hozon/adapter'
import type { Dialect, Driver } from 'kysely'
import { SQLocalKysely } from 'sqlocal/kysely'

export type SQLocalAdapterParams = {
  /** OPFS database file name, for example `hozon.sqlite3`. */
  database: string
}

export class SQLocalAdapter extends AbstractSQLiteAdapter<{
  Binary: Uint8Array
  JSON: string
  Timestamp: number
}> {
  #sqlocal: SQLocalKysely
  #dialect: Dialect
  #closing: Promise<void> | undefined

  constructor(params: SQLocalAdapterParams) {
    super()
    this.#sqlocal = new SQLocalKysely({
      databasePath: params.database,
      onInit: (sql) => [sql`PRAGMA foreign_keys = ON`],
    })
    const sqlocalDialect = this.#sqlocal.dialect
    // Kysely destroys the driver, which destroys the SQLocal client, and the adapter is closed
    // as well. SQLocal throws when destroyed twice, so route both through one idempotent close.
    this.#dialect = {
      createAdapter: () => sqlocalDialect.createAdapter(),
      createDriver: (): Driver => {
        const driver = sqlocalDialect.createDriver()
        return {
          init: () => driver.init(),
          acquireConnection: () => driver.acquireConnection(),
          beginTransaction: (connection, settings) => driver.beginTransaction(connection, settings),
          commitTransaction: (connection) => driver.commitTransaction(connection),
          rollbackTransaction: (connection) => driver.rollbackTransaction(connection),
          releaseConnection: (connection) => driver.releaseConnection(connection),
          destroy: () => this.close(),
        }
      },
      createIntrospector: (db) => sqlocalDialect.createIntrospector(db),
      createQueryCompiler: () => sqlocalDialect.createQueryCompiler(),
    }
  }

  get dialect(): Dialect {
    return this.#dialect
  }

  get sqlocal(): SQLocalKysely {
    return this.#sqlocal
  }

  close(): Promise<void> {
    this.#closing ??= this.#sqlocal.destroy()
    return this.#closing
  }
}
