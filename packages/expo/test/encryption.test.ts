import type { SQLiteDatabase } from 'expo-sqlite'
import { describe, expect, test, vi } from 'vitest'

import { applyEncryptionKey, keyPragma } from '../src/encryption.js'

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const KEY_PRAGMA = `PRAGMA key = "x'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'"`

function createDatabase(cipherVersion: string | null) {
  const statements: Array<string> = []
  const execSync = vi.fn((source: string) => {
    statements.push(source)
  })
  const getFirstSync = vi.fn((source: string) => {
    statements.push(source)
    return cipherVersion == null ? null : { cipher_version: cipherVersion }
  })
  const database = { execSync, getFirstSync } as unknown as SQLiteDatabase
  return { database, execSync, statements }
}

describe('keyPragma', () => {
  test('encodes a 32-byte key as a raw hex key', () => {
    expect(keyPragma(KEY)).toBe(KEY_PRAGMA)
  })

  test('rejects keys of the wrong length or type', () => {
    expect(() => keyPragma(new Uint8Array(16))).toThrow('32-byte Uint8Array')
    expect(() => keyPragma('secret' as unknown as Uint8Array)).toThrow('32-byte Uint8Array')
  })
})

describe('applyEncryptionKey', () => {
  test('keys the handle first, then verifies the key against the file', () => {
    const { database, statements } = createDatabase('4.6.1 community')
    applyEncryptionKey(database, KEY)
    expect(statements).toEqual([
      KEY_PRAGMA,
      'PRAGMA cipher_version',
      'SELECT count(*) FROM sqlite_master',
    ])
  })

  test('throws when SQLCipher is not linked', () => {
    for (const version of [null, '']) {
      const { database, execSync } = createDatabase(version)
      expect(() => applyEncryptionKey(database, KEY)).toThrow('SQLCipher is not available')
      expect(execSync).toHaveBeenCalledTimes(1)
    }
  })

  test('propagates the error from a wrong key', () => {
    const { database, execSync } = createDatabase('4.6.1 community')
    execSync.mockImplementation((source: string) => {
      if (source.startsWith('SELECT')) throw new Error('file is not a database')
    })
    expect(() => applyEncryptionKey(database, KEY)).toThrow('file is not a database')
  })
})
