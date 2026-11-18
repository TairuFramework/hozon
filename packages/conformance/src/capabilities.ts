import type { ConformanceCase } from './runner.js'

export type ConformanceCapabilities = {
  concurrentReaders?: boolean
}

export function supportsCase(
  entry: ConformanceCase,
  capabilities: ConformanceCapabilities = {},
): boolean {
  const required = entry.capabilities?.concurrentReaders
  return required === undefined || required === (capabilities.concurrentReaders ?? false)
}
