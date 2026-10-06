import type { Adapter } from '@hozon/adapter'
import { chunk, withKeepSet, withStoreTransaction } from '@hozon/db'
import type { Kysely } from 'kysely'

import type { TelemetryTables } from './tables.js'
import type { TelemetryStore } from './types.js'

export function createTelemetryStoreAPI(
  db: Kysely<TelemetryTables>,
  adapter: Adapter,
): TelemetryStore {
  return {
    async addSpans(spans) {
      if (spans.length === 0) return
      const rows = spans.map((span) => ({
        trace_id: span.traceID,
        span_id: span.spanID,
        start_time: span.startTime,
        end_time: span.endTime,
        data: adapter.encodeJSON(span),
      }))
      await withStoreTransaction(db, async (trx) => {
        for (const batch of chunk(rows, 100)) {
          await trx
            .insertInto('hozon_spans')
            .values(batch)
            .onConflict((conflict) =>
              conflict.columns(['trace_id', 'span_id']).doUpdateSet((eb) => ({
                start_time: eb.ref('excluded.start_time'),
                end_time: eb.ref('excluded.end_time'),
                data: eb.ref('excluded.data'),
              })),
            )
            .execute()
        }
      })
    },
    async getSpans(traceID) {
      const rows = await db
        .selectFrom('hozon_spans')
        .select('data')
        .where('trace_id', '=', traceID)
        .orderBy('start_time')
        .orderBy('seq')
        .execute()
      return rows.map((row) => row.data)
    },
    async deleteByTrace(traceIDs) {
      if (traceIDs.length === 0) return 0
      return withStoreTransaction(db, async (trx) => {
        let count = 0
        for (const ids of chunk(traceIDs)) {
          const result = await trx
            .deleteFrom('hozon_spans')
            .where('trace_id', 'in', ids)
            .executeTakeFirstOrThrow()
          count += Number(result.numDeletedRows)
        }
        return count
      })
    },
    async deleteBefore(time, params) {
      if (params?.keepTraceIDs?.length === 0) return 0
      return withStoreTransaction(db, async (trx) => {
        return withKeepSet(
          trx,
          { table: 'hozon_keep_telemetry', ids: params?.keepTraceIDs ?? [] },
          async (selectKeep) => {
            const result = await trx
              .deleteFrom('hozon_spans')
              .where('end_time', '<', time)
              .where('trace_id', 'not in', selectKeep())
              .executeTakeFirstOrThrow()
            return Number(result.numDeletedRows)
          },
        )
      })
    },
  }
}
