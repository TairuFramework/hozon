import { createRequire } from 'node:module'
import type { NativeSQLite } from '@hozon/adapter'

const require = createRequire(import.meta.url)
export function loadBinding(): NativeSQLite {
  try {
    return require('../native/hozon-sqlite-napi.node') as NativeSQLite
  } catch (error) {
    throw new Error(
      'Build hozon-sqlite-napi and copy it to packages/native/native/hozon-sqlite-napi.node before running native tests',
      { cause: error },
    )
  }
}
