import type { DatabaseSync, StatementSync } from 'node:sqlite'

type WrappedStatement = {
  readonly reader: boolean
  all(parameters: ReadonlyArray<unknown>): Array<unknown>
  run(parameters: ReadonlyArray<unknown>): {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>
}

export type WrappedDatabase = {
  close(): void
  prepare(sql: string): WrappedStatement
}

function bindParameters(parameters: ReadonlyArray<unknown>): Array<unknown> {
  return parameters.map((value) => (typeof value === 'boolean' ? Number(value) : value))
}

export function wrapDatabase(database: DatabaseSync): WrappedDatabase {
  let closed = false

  return {
    close(): void {
      if (closed) {
        return
      }
      closed = true
      database.close()
    },
    prepare(sql: string): WrappedStatement {
      const statement: StatementSync = database.prepare(sql)

      return {
        get reader(): boolean {
          return statement.columns().length > 0
        },
        all(parameters: ReadonlyArray<unknown>): Array<unknown> {
          return statement.all(...(bindParameters(parameters) as Array<never>))
        },
        run(parameters: ReadonlyArray<unknown>): {
          changes: number | bigint
          lastInsertRowid: number | bigint
        } {
          return statement.run(...(bindParameters(parameters) as Array<never>))
        },
        iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
          return statement.iterate(
            ...(bindParameters(parameters) as Array<never>),
          ) as IterableIterator<unknown>
        },
      }
    },
  }
}
