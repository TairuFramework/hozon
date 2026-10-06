import { summarize } from '@hozon/conformance'
import type { ScenarioPhase } from 'hozon-test-scenarios'
import { useState } from 'react'

import type { RunReport } from './global.js'

export default function App() {
  const [report, setReport] = useState<RunReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const start = (phase: ScenarioPhase) => {
    setRunning(true)
    setReport(null)
    setError(null)
    window.hozon
      .run(phase)
      .then(setReport)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
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
      {error ? <p data-testid="error">Error: {error}</p> : null}
      {report ? (
        <>
          <p data-testid="conformance-summary">
            {summarize(report.conformance).line('Conformance')}
          </p>
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
