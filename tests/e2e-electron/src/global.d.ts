import type { ConformanceResult } from '@hozon/conformance'
import type { ScenarioPhase } from 'hozon-test-scenarios'

export type RunReport = {
  conformance: Array<ConformanceResult>
  stores: Array<ConformanceResult>
}

export type SQLiteCheck = {
  ok: boolean
  versions: NodeJS.ProcessVersions
  error?: string
}

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: extend interface
  interface Window {
    hozon: {
      run: (phase: ScenarioPhase) => Promise<RunReport>
      sqliteCheck: () => Promise<SQLiteCheck>
    }
  }
}
