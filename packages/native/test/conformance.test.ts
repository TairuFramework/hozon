import type { NativeOpenOptions } from '@hozon/adapter'
import { defineVitestSuite } from '@hozon/conformance/vitest'

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
  nativeSQLite: sqlite,
  createAdapter: async () => new NativeAdapter({ sqlite, database: ':memory:' }),
  capabilities: {
    singleWriter: true,
    concurrentReaders: true,
    admissionControl: true,
    admissionExpiry: true,
    nativeTransactions: true,
  },
  admissionControl: async (adapter) => {
    const db = await (adapter as NativeAdapter).database
    if (!binding.admissionExpiry(db))
      throw new Error('Expiry must be enabled for expiry conformance')
    return { sqlite, db, timeoutMs: 40 }
  },
})
