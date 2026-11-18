import { defineVitestSuite } from '../../conformance/src/vitest.js'
import { NativeAdapter } from '../src/index.js'
import { loadBinding } from './binding.js'

const sqlite = loadBinding()
defineVitestSuite({
  name: 'Rust SQLite',
  createAdapter: async () => new NativeAdapter({ sqlite, database: ':memory:' }),
  capabilities: { concurrentReaders: true, admissionControl: true },
  admissionControl: async (adapter) => ({
    sqlite,
    db: await (adapter as NativeAdapter).database,
    timeoutMs: 40,
  }),
})
