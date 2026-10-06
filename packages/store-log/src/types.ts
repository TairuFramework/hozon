import type { JSONValue } from '@sozai/json'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
export type StoredLog = {
  traceID?: string
  spanID?: string
  timestamp: number
  level: LogLevel
  category: Array<string>
  message: string
  properties: Record<string, JSONValue>
}
export type TracedLog = StoredLog & { traceID: string; spanID: string }
export function isTracedLog(log: StoredLog): log is TracedLog {
  return log.traceID !== undefined && log.spanID !== undefined
}
export type QueryLogsParams = {
  from?: number
  to?: number
  levels?: Array<LogLevel>
  categoryPrefix?: Array<string>
  traceID?: string
  limit: number
  cursor?: string
}
export type LogStore = {
  addLogs(logs: Array<StoredLog>): Promise<void>
  queryLogs(params: QueryLogsParams): Promise<{ logs: Array<StoredLog>; cursor?: string }>
  getTraceLogs(traceID: string): Promise<Array<TracedLog>>
  deleteByTrace(traceIDs: Array<string>): Promise<number>
  deleteBefore(time: number, params?: { keepTraceIDs?: Array<string> }): Promise<number>
}
