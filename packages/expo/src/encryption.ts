import type { SQLiteDatabase } from 'expo-sqlite'

/** SQLCipher raw key length in bytes. */
export const ENCRYPTION_KEY_LENGTH = 32

/** Builds the `PRAGMA key` statement for a raw 32-byte key. PRAGMA cannot bind parameters. */
export function keyPragma(key: Uint8Array): string {
  if (!(key instanceof Uint8Array) || key.length !== ENCRYPTION_KEY_LENGTH) {
    throw new TypeError(`Encryption key must be a ${ENCRYPTION_KEY_LENGTH}-byte Uint8Array`)
  }
  const hex = Array.from(key, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `PRAGMA key = "x'${hex}'"`
}

/**
 * Keys an open handle, then checks SQLCipher is linked and the key matches the file.
 * Must run before any other statement on the handle.
 */
export function applyEncryptionKey(database: SQLiteDatabase, key: Uint8Array): void {
  database.execSync(keyPragma(key))
  // Stock SQLite ignores `PRAGMA key` and would leave the file in plaintext.
  const version = database.getFirstSync<{ cipher_version: string }>('PRAGMA cipher_version')
  if (!version?.cipher_version) {
    throw new Error(
      'SQLCipher is not available: set `useSQLCipher: true` in the expo-sqlite config plugin',
    )
  }
  // A wrong key only fails on the first read of the file.
  database.execSync('SELECT count(*) FROM sqlite_master')
}
