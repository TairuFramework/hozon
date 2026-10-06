import type { Adapter } from '@hozon/adapter'
import { chunk, withKeepSet, withStoreTransaction } from '@hozon/db'
import type { Kysely } from 'kysely'

import { categoryRange, encodeCategory } from './category.js'
import type { LogTables } from './tables.js'
import type { LogStore, TracedLog } from './types.js'

function encodeCursor(timestamp: number, seq: number): string {
  return btoa(JSON.stringify([timestamp, seq]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
function decodeCursor(cursor: string): [number, number] {
  try {
    const value: unknown = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')))
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((item) => typeof item === 'number' && Number.isFinite(item)) ||
      !Number.isInteger(value[1])
    ) {
      throw new TypeError('Invalid log cursor')
    }
    return value as [number, number]
  } catch (cause) {
    throw new TypeError('Invalid log cursor', { cause })
  }
}

export function createLogStoreAPI(db: Kysely<LogTables>, adapter: Adapter): LogStore {
  return {
    async addLogs(logs) {
      if (logs.length === 0) return
      // Validate and encode the whole input before writing any batch.
      const rows = logs.map((log, index) => {
        if ((log.traceID === undefined) !== (log.spanID === undefined)) {
          throw new TypeError(`Unpaired trace/span IDs at index ${index}`)
        }
        return {
          timestamp: log.timestamp,
          level: log.level,
          category: encodeCategory(log.category),
          trace_id: log.traceID ?? null,
          span_id: log.spanID ?? null,
          data: adapter.encodeJSON(log),
        }
      })
      await withStoreTransaction(db, async (trx) => {
        for (const batch of chunk(rows, 71)) {
          await trx.insertInto('hozon_logs').values(batch).execute()
        }
      })
    },
    async queryLogs(params) {
      if (!Number.isInteger(params.limit) || params.limit <= 0)
        throw new RangeError('Log limit must be a positive integer')
      const limit = Math.min(params.limit, 1000)
      let query = db.selectFrom('hozon_logs').select(['timestamp', 'seq', 'data'])
      if (params.from !== undefined) query = query.where('timestamp', '>=', params.from)
      if (params.to !== undefined) query = query.where('timestamp', '<=', params.to)
      if (params.levels !== undefined) {
        if (params.levels.length === 0) return { logs: [] }
        query = query.where('level', 'in', [...new Set(params.levels)])
      }
      if (params.categoryPrefix !== undefined && params.categoryPrefix.length > 0) {
        const { gte, lt } = categoryRange(params.categoryPrefix)
        query = query.where('category', '>=', gte).where('category', '<', lt)
      }
      if (params.traceID !== undefined) query = query.where('trace_id', '=', params.traceID)
      if (params.cursor !== undefined) {
        const [timestamp, seq] = decodeCursor(params.cursor)
        query = query.where((eb) =>
          eb.or([
            eb('timestamp', '>', timestamp),
            eb.and([eb('timestamp', '=', timestamp), eb('seq', '>', seq)]),
          ]),
        )
      }
      const rows = await query
        .orderBy('timestamp')
        .orderBy('seq')
        .limit(limit + 1)
        .execute()
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        logs: page.map((row) => row.data),
        ...(rows.length > limit && last !== undefined
          ? { cursor: encodeCursor(last.timestamp, last.seq) }
          : {}),
      }
    },
    async getTraceLogs(traceID) {
      const rows = await db
        .selectFrom('hozon_logs')
        .select('data')
        .where('trace_id', '=', traceID)
        .orderBy('timestamp')
        .orderBy('seq')
        .execute()
      // addLogs enforces paired IDs for every traced row.
      return rows.map((row) => row.data as TracedLog)
    },
    async deleteByTrace(traceIDs) {
      if (traceIDs.length === 0) return 0
      return withStoreTransaction(db, async (trx) => {
        let count = 0
        for (const ids of chunk(traceIDs)) {
          const result = await trx
            .deleteFrom('hozon_logs')
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
          { table: 'hozon_keep_log', ids: params?.keepTraceIDs ?? [] },
          async (selectKeep) => {
            const result = await trx
              .deleteFrom('hozon_logs')
              .where('timestamp', '<', time)
              .where((eb) =>
                eb.or([eb('trace_id', 'is', null), eb('trace_id', 'not in', selectKeep())]),
              )
              .executeTakeFirstOrThrow()
            return Number(result.numDeletedRows)
          },
        )
      })
    },
  }
}
