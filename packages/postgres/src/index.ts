import { AbstractPostgresAdapter } from '@hozon/adapter'
import type {
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
} from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres, { type Options, type PostgresType } from 'postgres'

export type PostgresAdapterParams = {
  url: string
  options?: Options<Record<string, PostgresType>>
  closeTimeoutSeconds?: number
}

const CLOSE_TIMEOUT_SECONDS = 5

type ClosingPostgresJSDialectParams = {
  dialect: PostgresJSDialect
  end: () => Promise<void>
}

class ClosingPostgresJSDialect implements Dialect {
  #dialect: PostgresJSDialect
  #end: () => Promise<void>

  constructor(params: ClosingPostgresJSDialectParams) {
    this.#dialect = params.dialect
    this.#end = params.end
  }

  createAdapter(): DialectAdapter {
    return this.#dialect.createAdapter()
  }

  createDriver(): Driver {
    const driver = this.#dialect.createDriver()
    driver.destroy = this.#end
    return driver
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return this.#dialect.createIntrospector(db)
  }

  createQueryCompiler(): QueryCompiler {
    return this.#dialect.createQueryCompiler()
  }
}

export class PostgresAdapter extends AbstractPostgresAdapter {
  #dialect: Dialect
  #closing: Promise<void> | null = null
  #end: () => Promise<void>

  constructor(params: PostgresAdapterParams) {
    super()
    const options: Options<Record<string, PostgresType>> = {
      ...params.options,
      types: {
        int8: {
          to: 20,
          from: [20],
          serialize: (value: number) => String(value),
          parse: (value: string) => Number(value),
        },
        ...params.options?.types,
      },
    }
    const client = postgres(params.url, options)
    const timeout = params.closeTimeoutSeconds ?? CLOSE_TIMEOUT_SECONDS
    this.#end = (): Promise<void> => {
      this.#closing ??= client.end({ timeout })
      return this.#closing
    }
    this.#dialect = new ClosingPostgresJSDialect({
      dialect: new PostgresJSDialect({ postgres: client }),
      end: this.#end,
    })
  }

  get dialect(): Dialect {
    return this.#dialect
  }

  // postgres.js serializes parameters by the server-inferred type, and its boolean
  // serializer maps anything but `true` (including the string 'true') to 'f', so booleans
  // stay native here instead of taking the generic text coercion.
  coerceFilterValue(value: unknown): unknown {
    return typeof value === 'boolean' ? value : super.coerceFilterValue(value)
  }

  close(): Promise<void> {
    return this.#end()
  }
}
