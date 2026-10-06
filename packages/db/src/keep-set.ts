import type { Kysely, SelectQueryBuilder } from 'kysely'
import { sql } from 'kysely'

export function chunk<T>(items: Array<T>, size = 500): Array<Array<T>> {
  if (!Number.isInteger(size) || size <= 0)
    throw new RangeError('Chunk size must be a positive integer')
  const chunks: Array<Array<T>> = []
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size))
  }
  return chunks
}

type KeepTable = { keep: { trace_id: string } }

export async function withKeepSet<DB, R>(
  db: Kysely<DB>,
  params: { table: string; ids: Array<string> },
  fn: (selectKeep: () => SelectQueryBuilder<KeepTable, 'keep', { trace_id: string }>) => Promise<R>,
): Promise<R> {
  if (!db.isTransaction) throw new Error('withKeepSet requires a transaction')
  await sql`CREATE TEMP TABLE ${sql.table(params.table)} (trace_id text PRIMARY KEY)`.execute(db)
  let failed = false
  try {
    const keepDB = db as unknown as Kysely<Record<string, { trace_id: string }>>
    for (const ids of chunk(params.ids)) {
      await keepDB
        .insertInto(params.table)
        .values(ids.map((traceID) => ({ trace_id: traceID })))
        .onConflict((conflict) => conflict.doNothing())
        .execute()
    }
    return await fn(
      () =>
        keepDB.selectFrom(`${params.table} as keep`).select('trace_id') as SelectQueryBuilder<
          KeepTable,
          'keep',
          { trace_id: string }
        >,
    )
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await sql`DROP TABLE ${sql.table(params.table)}`.execute(db)
    } catch (error) {
      // Cleanup must not replace the primary failure, including an aborted transaction.
      // biome-ignore lint/correctness/noUnsafeFinally: Surface cleanup failure only without a primary failure.
      if (!failed) throw error
    }
  }
}
