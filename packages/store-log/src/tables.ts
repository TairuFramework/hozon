import type { ColumnType, Generated } from 'kysely'

import type { LogLevel, StoredLog } from './types.js'

export type LogTables = {
  hozon_logs: {
    seq: Generated<number>
    timestamp: number
    level: LogLevel
    category: string
    trace_id: string | null
    span_id: string | null
    data: ColumnType<StoredLog, unknown, unknown>
  }
}
