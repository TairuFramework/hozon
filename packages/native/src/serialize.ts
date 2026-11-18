import type { NativeValue } from '@hozon/adapter'

/** Copy bind parameters into SQLite's supported scalar types. */
export function serialize(parameters: Array<unknown>): Array<NativeValue> {
  return parameters.map((value): NativeValue => {
    if (value === null || value === undefined) return null
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')
      return value
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Uint8Array) return value
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'object') return JSON.stringify(value)
    throw new Error(`Unsupported bind value type: ${typeof value}`)
  })
}
