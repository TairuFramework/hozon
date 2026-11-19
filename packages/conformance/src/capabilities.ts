import type { ConformanceCase } from './runner.js'

export type ConformanceCapabilities = {
  /** One writer per database: root transactions and autocommit writes wait for the active writer.
   * SQLite-family adapters enable this; pooled Postgres connections do not serialize writers.
   * Independent of concurrentReaders, which controls outside-read routing.
   */
  singleWriter?: boolean
  concurrentReaders?: boolean
  admissionControl?: boolean
  /** The open database actively expires queued admissions, regardless of build profile. */
  admissionExpiry?: boolean
}

export function supportsCase(
  entry: ConformanceCase,
  capabilities: ConformanceCapabilities = {},
): boolean {
  return (
    ['singleWriter', 'concurrentReaders', 'admissionControl', 'admissionExpiry'] as const
  ).every((capability) => {
    const required = entry.capabilities?.[capability]
    return required === undefined || required === (capabilities[capability] ?? false)
  })
}
