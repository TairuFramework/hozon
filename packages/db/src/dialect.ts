import type {
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  MigrationLockOptions,
  QueryCompiler,
} from 'kysely'

/**
 * Delegates to a SQLite dialect adapter but reports transactional DDL support.
 *
 * Kysely's SQLite adapters report `supportsTransactionalDdl = false`, so its Migrator runs
 * SQLite migrations outside a transaction and a failed migration leaves partial schema
 * behind. SQLite does support transactional DDL, so HozonDB opts in for every SQLite
 * driver regardless of which dialect it supplies.
 */
class TransactionalDDLAdapter implements DialectAdapter {
  #adapter: DialectAdapter

  constructor(adapter: DialectAdapter) {
    this.#adapter = adapter
  }

  get supportsCreateIfNotExists(): boolean | undefined {
    return this.#adapter.supportsCreateIfNotExists
  }

  get supportsMultipleConnections(): boolean | undefined {
    return this.#adapter.supportsMultipleConnections
  }

  get supportsTransactionalDdl(): boolean {
    return true
  }

  get supportsReturning(): boolean | undefined {
    return this.#adapter.supportsReturning
  }

  get supportsOutput(): boolean | undefined {
    return this.#adapter.supportsOutput
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches Kysely's DialectAdapter signature.
  acquireMigrationLock(db: Kysely<any>, options: MigrationLockOptions): Promise<void> {
    return this.#adapter.acquireMigrationLock(db, options)
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches Kysely's DialectAdapter signature.
  releaseMigrationLock(db: Kysely<any>, options: MigrationLockOptions): Promise<void> {
    return this.#adapter.releaseMigrationLock(db, options)
  }
}

class TransactionalDDLDialect implements Dialect {
  #dialect: Dialect

  constructor(dialect: Dialect) {
    this.#dialect = dialect
  }

  createAdapter(): DialectAdapter {
    return new TransactionalDDLAdapter(this.#dialect.createAdapter())
  }

  createDriver(): Driver {
    return this.#dialect.createDriver()
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches Kysely's Dialect signature.
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return this.#dialect.createIntrospector(db)
  }

  createQueryCompiler(): QueryCompiler {
    return this.#dialect.createQueryCompiler()
  }
}

/** Wraps a SQLite dialect so Kysely's Migrator runs each migration run in a transaction. */
export function withTransactionalDDL(dialect: Dialect): Dialect {
  return new TransactionalDDLDialect(dialect)
}
