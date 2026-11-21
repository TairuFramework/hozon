import type { WritePriority } from './types.js'

/** Opaque native identifiers, passed explicitly on every call. */
export type NativeDBHandle = string
export type TxID = string

export type NativeTransactionRef = { database: NativeDBHandle; txID: TxID }

/** Integer cells are numbers when |value| <= Number.MAX_SAFE_INTEGER (2^53 - 1),
 * and bigint beyond that. Bigint parameters bind exactly throughout signed i64,
 * including the safe range. NativeResult changes and lastInsertRowID stay bigint.
 */
export type NativeValue = null | number | bigint | string | Uint8Array

export type NativeResult = {
  rows: Array<Array<NativeValue>>
  columns: Array<string>
  changes: bigint
  lastInsertRowID: bigint
}

export type NativeAdmission = { admissionID: string; txID: TxID }

export type NativePendingAdmission = {
  /** Assigned synchronously at submission; abandon accepts it while pending or granted.
   * A JS admission timeout uses this ID to abandon without waiting for a grant.
   */
  readonly admissionID: string
  /** Settles on grant (with the txID), expiry, abandon, or database close. */
  readonly granted: Promise<NativeAdmission>
}

export type NativeOpenOptions = {
  readers: number
  busyTimeoutMs: number
  journalMode: 'wal'
  /** Diagnose queued admissions after 10 s (or the requested timeout).
   * Defaults to true in napi debug builds and false in release builds.
   * Mobile hosts should explicitly select their development policy.
   */
  expireAdmissions?: boolean
}

export type NativeBeginOptions = { timeoutMs?: number; priority?: WritePriority }

export type NativeSQLite = {
  open(path: string, options: NativeOpenOptions): Promise<NativeDBHandle>
  close(db: NativeDBHandle): Promise<void>
  beginWrite(db: NativeDBHandle, options?: NativeBeginOptions): NativePendingAdmission
  abandon(db: NativeDBHandle, admissionID: string): Promise<void>
  commit(db: NativeDBHandle, txID: TxID): Promise<void>
  rollback(db: NativeDBHandle, txID: TxID): Promise<void>
  /** Background callers only. Throws HOZON_SYNC_READ_BUSY when leased (use async
   * execute instead), or HOZON_SYNC_READ_TRANSACTION for a non-null txID.
   * Hosts without calling-thread reads may omit this capability.
   */
  executeReadSync?(
    db: NativeDBHandle,
    txID: TxID | null,
    sql: string,
    params: Array<NativeValue>,
  ): NativeResult
  execute(
    db: NativeDBHandle,
    txID: TxID | null,
    sql: string,
    params: Array<NativeValue>,
    mode: 'read' | 'write',
  ): Promise<NativeResult>
}
