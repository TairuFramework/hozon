import { type ConformanceResult, runConformance, summarize } from '@hozon/conformance'
import { HozonDB } from '@hozon/db'
import { ExpoAdapter } from '@hozon/expo'
import { StackContextManager } from '@opentelemetry/sdk-trace-web'
import { deleteDatabaseAsync } from 'expo-sqlite'
import { StatusBar } from 'expo-status-bar'
import { runStoreScenario, type ScenarioPhase, setupTelemetry } from 'hozon-test-scenarios'
import { useState } from 'react'
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native'

const DATABASE = 'hozon-e2e.db'

type Report = {
  conformance: Array<ConformanceResult>
  stores: Array<ConformanceResult>
  error: string | null
}

async function runConformancePhase(): Promise<Array<ConformanceResult>> {
  let count = 0
  let current: string | undefined
  return await runConformance({
    async createAdapter() {
      current = `case-${count++}.db`
      // A previous run may have been interrupted before cleanup.
      await deleteDatabaseAsync(current).catch(() => {})
      return new ExpoAdapter({ database: current })
    },
    async cleanup() {
      // The case already closed its adapter, so the file can be deleted.
      if (current === undefined) return
      const database = current
      current = undefined
      await deleteDatabaseAsync(database)
    },
  })
}

async function runPhase(phase: ScenarioPhase): Promise<Report> {
  const conformance = await runConformancePhase()
  const db = new HozonDB({ adapter: new ExpoAdapter({ database: DATABASE }) })
  const telemetry = await setupTelemetry({ contextManager: new StackContextManager(), db })
  try {
    const stores = await runStoreScenario({ db, phase, runID: 'expo' })
    return { conformance, stores, error: null }
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
          conformance: [],
          stores: [],
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setRunning(false))
  }

  const results = report ? [...report.conformance, ...report.stores] : []
  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <View style={styles.buttons}>
        <Button
          testID="write"
          title="Run write phase"
          disabled={running}
          onPress={() => start('write')}
        />
        <Button
          testID="verify"
          title="Run verify phase"
          disabled={running}
          onPress={() => start('verify')}
        />
      </View>
      {running ? <Text testID="running">Running…</Text> : null}
      {report ? <Text testID="done">Done</Text> : null}
      {report?.error ? <Text testID="error">Error: {report.error}</Text> : null}
      {report && report.error == null ? (
        <>
          <Text testID="conformance-summary">
            {summarize(report.conformance).line('Conformance')}
          </Text>
          <Text testID="stores-summary">{summarize(report.stores).line('Stores')}</Text>
        </>
      ) : null}
      <ScrollView style={styles.results}>
        {results.map((result) => (
          <Text key={result.name} testID={`result-${result.name}`} style={styles.result}>
            {result.ok ? 'PASS' : 'FAIL'} {result.name}
            {result.error ? `: ${result.error}` : ''}
          </Text>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 12,
  },
  results: {
    flex: 1,
    marginTop: 12,
  },
  result: {
    fontSize: 12,
    marginBottom: 2,
  },
})
