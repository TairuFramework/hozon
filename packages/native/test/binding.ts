import { createRequire } from 'node:module'
import type { NativeSQLite } from '@hozon/adapter'

const require = createRequire(import.meta.url)
// Per-database capability reflects the selected open policy, including release overrides.
export type SQLiteBinding = NativeSQLite & { admissionExpiry(db: string): boolean }
export function loadBinding(): SQLiteBinding {
  try {
    return require('../native/hozon-sqlite-napi.node') as SQLiteBinding
  } catch (error) {
    throw new Error(
      'Build hozon-sqlite-napi and copy it to packages/native/native/hozon-sqlite-napi.node before running native tests',
      { cause: error },
    )
  }
}
