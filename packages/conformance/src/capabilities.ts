import type { ConformanceCase } from './runner.js'

export type ConformanceCapabilities = {
  concurrentReaders?: boolean
  admissionControl?: boolean
  /** The open database actively expires queued admissions, regardless of build profile. */
  admissionExpiry?: boolean
}

export function supportsCase(
  entry: ConformanceCase,
  capabilities: ConformanceCapabilities = {},
): boolean {
  return (['concurrentReaders', 'admissionControl', 'admissionExpiry'] as const).every(
    (capability) => {
      const required = entry.capabilities?.[capability]
      return required === undefined || required === (capabilities[capability] ?? false)
    },
  )
}
