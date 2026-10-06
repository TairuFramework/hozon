import { type ConformanceResult, runConformance, summarize } from '@hozon/conformance'
import { HozonDB } from '@hozon/db'
import { SQLocalAdapter } from '@hozon/sqlocal'
import { StackContextManager } from '@opentelemetry/sdk-trace-web'
import { runStoreScenario, type ScenarioPhase, setupTelemetry } from 'hozon-test-scenarios'
import { useState } from 'react'

const DATABASE = 'hozon-e2e.sqlite3'

type Report = {
  storage: string | null
  conformance: Array<ConformanceResult>
  stores: Array<ConformanceResult>
  error: string | null
}

async function runConformancePhase(): Promise<Array<ConformanceResult>> {
  let count = 0
  let current: string | undefined
  return await runConformance({
    async createAdapter() {
      current = `case-${count++}.sqlite3`
      return new SQLocalAdapter({ database: current })
    },
    async cleanup() {
      // The case already closed its adapter; delete the file through a fresh client.
      if (current === undefined) return
      const client = new SQLocalAdapter({ database: current })
      current = undefined
      await client.sqlocal.deleteDatabaseFile(undefined, true)
    },
  })
}

async function runPhase(phase: ScenarioPhase): Promise<Report> {
  const adapter = new SQLocalAdapter({ database: DATABASE })
  const info = await adapter.sqlocal.getDatabaseInfo()
  if (info.storageType !== 'opfs') {
    await adapter.close()
    return { storage: info.storageType ?? 'unknown', conformance: [], stores: [], error: null }
  }
  const conformance = await runConformancePhase()
  const db = new HozonDB({ adapter })
  const telemetry = await setupTelemetry({ contextManager: new StackContextManager(), db })
  try {
    const stores = await runStoreScenario({ db, phase, runID: 'web' })
    return { storage: 'opfs', conformance, stores, error: null }
  } finally {
    await telemetry.teardown()
    await db.close()
  }
}

export default function App() {
  const [report, setReport] = useState<Report | null>(null)
  const [running, setRunning] = useState(false)

  const start = (phase: ScenarioPhase) => {
    setRunning(true)
    setReport(null)
    runPhase(phase)
      .then(setReport)
      .catch((error: unknown) =>
        setReport({
          storage: null,
          conformance: [],
          stores: [],
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setRunning(false))
  }

  const results = report ? [...report.conformance, ...report.stores] : []
  return (
    <main style={{ padding: 16, fontFamily: 'sans-serif' }}>
      <button type="button" disabled={running} onClick={() => start('write')}>
        Run write phase
      </button>{' '}
      <button type="button" disabled={running} onClick={() => start('verify')}>
        Run verify phase
      </button>
      {report?.error ? <p data-testid="error">Error: {report.error}</p> : null}
      {report && report.storage !== 'opfs' && report.error == null ? (
        <p data-testid="storage">Storage: NOT OPFS ({report.storage})</p>
      ) : null}
      {report?.storage === 'opfs' ? (
        <>
          {report.conformance.length > 0 ? (
            <p data-testid="conformance-summary">
              {summarize(report.conformance).line('Conformance')}
            </p>
          ) : null}
          <p data-testid="stores-summary">{summarize(report.stores).line('Stores')}</p>
          <ul>
            {results.map((result) => (
              <li key={result.name} data-testid={`result-${result.name}`}>
                {result.ok ? 'PASS' : 'FAIL'} {result.name}
                {result.error ? `: ${result.error}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  )
}
