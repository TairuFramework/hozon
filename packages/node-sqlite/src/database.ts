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

function toMetadataValue(value: number | bigint): number | bigint {
  if (typeof value === 'number') {
    return value
  }
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value
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
          // run() converts the connection's last-insert row ID even when this statement
          // inserted nothing, so a row ID beyond the safe integer range would make every
          // later statement throw. Read the metadata as bigint and narrow it when safe.
          statement.setReadBigInts(true)
          try {
            const result = statement.run(...(bindParameters(parameters) as Array<never>))
            return {
              changes: toMetadataValue(result.changes),
              lastInsertRowid: toMetadataValue(result.lastInsertRowid),
            }
          } finally {
            statement.setReadBigInts(false)
          }
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
