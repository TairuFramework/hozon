import type { NativeOpenOptions } from '../../adapter/src/native.js'
import { defineVitestSuite } from '../../conformance/src/vitest.js'
import { NativeAdapter } from '../src/index.js'
import { loadBinding } from './binding.js'

const binding = loadBinding()
const sqlite = {
  ...binding,
  open: (path: string, options: NativeOpenOptions) =>
    binding.open(path, { ...options, expireAdmissions: true }),
}
defineVitestSuite({
  name: 'Rust SQLite',
  createAdapter: async () => new NativeAdapter({ sqlite, database: ':memory:' }),
  capabilities: { concurrentReaders: true, admissionControl: true, admissionExpiry: true },
  admissionControl: async (adapter) => {
    const db = await (adapter as NativeAdapter).database
    if (!binding.admissionExpiry(db))
      throw new Error('Expiry must be enabled for expiry conformance')
    return { sqlite, db, timeoutMs: 40 }
  },
})
