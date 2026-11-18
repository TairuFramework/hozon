/** Opaque native identifiers, passed explicitly on every call. */
export type NativeDBHandle = string
export type TxID = string

export type NativeValue = null | number | bigint | string | Uint8Array

export type NativeResult = {
  rows: Array<Array<NativeValue>>
  columns: Array<string>
  changes: bigint
  lastInsertRowID: bigint
}

export type NativeAdmission = { admissionID: string; txID: TxID }

export type NativeOpenOptions = {
  readers: number
  busyTimeoutMs: number
  journalMode: 'wal'
}

export type NativeSQLite = {
  open(path: string, options: NativeOpenOptions): Promise<NativeDBHandle>
  close(db: NativeDBHandle): Promise<void>
  beginWrite(db: NativeDBHandle, options?: { timeoutMs?: number }): Promise<NativeAdmission>
  abandon(db: NativeDBHandle, admissionID: string): Promise<void>
  commit(db: NativeDBHandle, txID: TxID): Promise<void>
  rollback(db: NativeDBHandle, txID: TxID): Promise<void>
  execute(
    db: NativeDBHandle,
    txID: TxID | null,
    sql: string,
    params: Array<NativeValue>,
    mode: 'read' | 'write',
  ): Promise<NativeResult>
}
