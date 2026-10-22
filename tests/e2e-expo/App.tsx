import { type ConformanceResult, runConformance, summarize } from '@hozon/conformance'
import { HozonDB } from '@hozon/db'
import { ExpoAdapter } from '@hozon/expo'
import { StackContextManager } from '@opentelemetry/sdk-trace'
import { deleteDatabaseAsync, openDatabaseSync } from 'expo-sqlite'
import { StatusBar } from 'expo-status-bar'
import { runStoreScenario, type ScenarioPhase, setupTelemetry } from 'hozon-test-scenarios'
import { useState } from 'react'
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native'

const DATABASE = 'hozon-e2e.db'
const ENCRYPTED_DATABASE = 'hozon-e2e-encrypted.db'
// Fixed test keys: the verify phase reopens the file written by a previous launch.
const ENCRYPTION_KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)

type Report = {
  conformance: Array<ConformanceResult>
  stores: Array<ConformanceResult>
  encryption: Array<ConformanceResult>
  error: string | null
}

async function runConformancePhase(encryptionKey?: Uint8Array): Promise<Array<ConformanceResult>> {
  const prefix = encryptionKey ? 'encrypted-' : ''
  let count = 0
  let current: string | undefined
  const results = await runConformance({
    async createAdapter() {
      current = `${prefix}case-${count++}.db`
      // A previous run may have been interrupted before cleanup.
      await deleteDatabaseAsync(current).catch(() => {})
      return new ExpoAdapter({ database: current, encryptionKey })
    },
    async cleanup() {
      // The case already closed its adapter, so the file can be deleted.
      if (current === undefined) return
      const database = current
      current = undefined
      await deleteDatabaseAsync(database)
    },
  })
  return results.map((result) => ({ ...result, name: `${prefix}${result.name}` }))
}

async function runStorePhase(params: {
  database: string
  encryptionKey?: Uint8Array
  phase: ScenarioPhase
  runID: string
}): Promise<Array<ConformanceResult>> {
  const adapter = new ExpoAdapter({
    database: params.database,
    encryptionKey: params.encryptionKey,
  })
  const db = new HozonDB({ adapter })
  const telemetry = await setupTelemetry({ contextManager: new StackContextManager(), db })
  try {
    return await runStoreScenario({ db, phase: params.phase, runID: params.runID })
  } finally {
    await telemetry.teardown()
    await db.close()
  }
}

async function check(name: string, fn: () => void | Promise<void>): Promise<ConformanceResult> {
  try {
    await fn()
    return { name, ok: true }
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function expectThrows(fn: () => void, pattern: RegExp): void {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (pattern.test(message)) return
    throw new Error(`Unexpected error: ${message}`, { cause: error })
  }
  throw new Error('Expected an error')
}

// Runs after the encrypted store scenario, so the file exists in both phases.
async function runEncryptionChecks(): Promise<Array<ConformanceResult>> {
  return [
    await check('encryption-rejects-wrong-key', () => {
      expectThrows(
        () => new ExpoAdapter({ database: ENCRYPTED_DATABASE, encryptionKey: WRONG_KEY }),
        /file is not a database/,
      )
    }),
    await check('encryption-unreadable-without-key', () => {
      const database = openDatabaseSync(ENCRYPTED_DATABASE)
      try {
        expectThrows(
          () => database.getAllSync('SELECT count(*) FROM sqlite_master'),
          /file is not a database/,
        )
      } finally {
        database.closeSync()
      }
    }),
  ]
}

async function runPhase(phase: ScenarioPhase): Promise<Report> {
  const conformance = [
    ...(await runConformancePhase()),
    ...(await runConformancePhase(ENCRYPTION_KEY)),
  ]
  const stores = await runStorePhase({ database: DATABASE, phase, runID: 'expo' })
  const encryption = [
    ...(await runStorePhase({
      database: ENCRYPTED_DATABASE,
      encryptionKey: ENCRYPTION_KEY,
      phase,
      runID: 'expo-encrypted',
    })),
    ...(await runEncryptionChecks()),
  ]
  return { conformance, stores, encryption, error: null }
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
          encryption: [],
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setRunning(false))
  }

  const results = report ? [...report.conformance, ...report.stores, ...report.encryption] : []
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
          <Text testID="encryption-summary">{summarize(report.encryption).line('Encryption')}</Text>
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
