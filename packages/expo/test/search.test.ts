import type { SQLiteDatabase } from 'expo-sqlite'
import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ openDatabaseSync: vi.fn() }))
vi.mock('expo-sqlite', () => mocks)

import { ExpoAdapter } from '../src/index.js'

describe('Expo search capability', () => {
  test.each([0, 1])('advertises search only with ENABLE_FTS5=%s', async (enabled) => {
    const getFirstSync = vi.fn(() => ({ enabled }))
    const closeAsync = vi.fn(async () => {})
    mocks.openDatabaseSync.mockReturnValue({
      execSync: vi.fn(),
      getFirstSync,
      closeAsync,
    } as unknown as SQLiteDatabase)
    const adapter = new ExpoAdapter({ database: ':memory:' })
    try {
      expect(adapter.search !== undefined).toBe(enabled === 1)
      expect(getFirstSync).toHaveBeenCalledWith(
        "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled",
      )
    } finally {
      await adapter.close()
    }
  })
})
