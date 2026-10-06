import type { ColumnType, Generated } from 'kysely'

import type { StoredSpan } from './types.js'

export type TelemetryTables = {
  hozon_spans: {
    seq: Generated<number>
    trace_id: string
    span_id: string
    start_time: number
    end_time: number
    data: ColumnType<StoredSpan, unknown, unknown>
  }
}
