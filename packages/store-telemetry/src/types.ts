import type { JSONValue } from '@sozai/json'

export type StoredSpan = {
  traceID: string
  spanID: string
  parentSpanID?: string
  name: string
  kind: number
  startTime: number
  endTime: number
  status: { code: number; message?: string }
  attributes: Record<string, JSONValue>
  events: Array<{ name: string; time: number; attributes: Record<string, JSONValue> }>
  links: Array<{ traceID: string; spanID: string }>
}
export type TelemetryStore = {
  addSpans(spans: Array<StoredSpan>): Promise<void>
  getSpans(traceID: string): Promise<Array<StoredSpan>>
  deleteByTrace(traceIDs: Array<string>): Promise<number>
  deleteBefore(time: number, params?: { keepTraceIDs?: Array<string> }): Promise<number>
}
