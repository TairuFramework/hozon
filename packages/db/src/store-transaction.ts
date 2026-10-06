import type { Kysely } from 'kysely'

export async function withStoreTransaction<DB, R>(
  db: Kysely<DB>,
  fn: (trx: Kysely<DB>) => Promise<R>,
): Promise<R> {
  return db.isTransaction ? fn(db) : db.transaction().execute(fn)
}
