import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type ConformanceResult, runConformance } from '@hozon/conformance'
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { app, BrowserWindow, ipcMain } from 'electron'
import { runStoreScenario, type ScenarioPhase, setupTelemetry } from 'hozon-test-scenarios'

import type { RunReport, SQLiteCheck } from './global.js'

// A fixed run ID lets the verify phase of a restarted app find the write phase's data.
const RUN_ID = 'electron'

async function checkSQLite(): Promise<SQLiteCheck> {
  const versions = process.versions
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(':memory:')
    try {
      const row = database.prepare('SELECT 1 AS value').get() as { value: number } | undefined
      if (row?.value !== 1) throw new Error('SELECT 1 did not return 1')
    } finally {
      database.close()
    }
    return { ok: true, versions }
  } catch (error) {
    return {
      ok: false,
      versions,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runConformancePhase(): Promise<Array<ConformanceResult>> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hozon-e2e-conformance-'))
  try {
    return await runConformance({
      async createAdapter() {
        return new NodeSQLiteAdapter({ database: path.join(directory, `${randomUUID()}.db`) })
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runPhase(phase: ScenarioPhase): Promise<RunReport> {
  const conformance = await runConformancePhase()
  const directory = app.getPath('userData')
  await mkdir(directory, { recursive: true })
  const db = new HozonDB({
    adapter: new NodeSQLiteAdapter({ database: path.join(directory, 'hozon-e2e.db') }),
  })
  const telemetry = await setupTelemetry({
    contextManager: new AsyncLocalStorageContextManager(),
    db,
  })
  try {
    const stores = await runStoreScenario({ db, phase, runID: RUN_ID })
    return { conformance, stores }
  } finally {
    await telemetry.teardown()
    await db.close()
  }
}

ipcMain.handle('hozon:sqlite-check', () => checkSQLite())
ipcMain.handle('hozon:run', (_event, phase: ScenarioPhase) => runPhase(phase))

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
}

app.on('ready', createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
