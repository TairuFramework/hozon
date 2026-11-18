import type { ConformanceCase } from './runner.js'

export type ConformanceCapabilities = {
  concurrentReaders?: boolean
  admissionControl?: boolean
}

export function supportsCase(
  entry: ConformanceCase,
  capabilities: ConformanceCapabilities = {},
): boolean {
  return (['concurrentReaders', 'admissionControl'] as const).every((capability) => {
    const required = entry.capabilities?.[capability]
    return required === undefined || required === (capabilities[capability] ?? false)
  })
}
