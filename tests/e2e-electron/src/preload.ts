import { contextBridge, ipcRenderer } from 'electron'
import type { ScenarioPhase } from 'hozon-test-scenarios'

import type { RunReport, SQLiteCheck } from './global.js'

contextBridge.exposeInMainWorld('hozon', {
  run: (phase: ScenarioPhase): Promise<RunReport> => ipcRenderer.invoke('hozon:run', phase),
  sqliteCheck: (): Promise<SQLiteCheck> => ipcRenderer.invoke('hozon:sqlite-check'),
})
