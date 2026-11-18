import { AbstractSQLiteAdapter, type NativeDBHandle, type NativeSQLite } from '@hozon/adapter'

import { NativeDialect } from './driver.js'

export type { NativePendingAdmission, NativeSQLite } from '@hozon/adapter'

export { NativeDialect, NativeDriver } from './driver.js'
export { serialize } from './serialize.js'

export type NativeAdapterParams = {
  sqlite: NativeSQLite
  database: string
  encryptionKey?: Uint8Array
  readers?: number
  busyTimeoutMs?: number
  admissionTimeoutMs?: number
}

/** Owns one Rust engine handle. The native implementation is supplied by the host. */
export class NativeAdapter extends AbstractSQLiteAdapter {
  #database: Promise<NativeDBHandle>
  #dialect: NativeDialect
  #closing?: Promise<void>
  constructor(params: NativeAdapterParams) {
    super()
    if (params.encryptionKey?.length) throw new Error('SQLCipher encryption is disabled')
    if (
      params.admissionTimeoutMs !== undefined &&
      (!Number.isInteger(params.admissionTimeoutMs) ||
        params.admissionTimeoutMs <= 0 ||
        params.admissionTimeoutMs > 2147483647)
    )
      throw new Error('admissionTimeoutMs must be an integer from 1 to 2147483647')
    this.#database = params.sqlite.open(params.database, {
      readers: params.readers ?? 4,
      busyTimeoutMs: params.busyTimeoutMs ?? 5000,
      journalMode: 'wal',
    })
    // Opening is eager: preserve rejection for callers without an unhandled rejection.
    void this.#database.catch(() => {})
    this.#dialect = new NativeDialect({
      sqlite: params.sqlite,
      database: this.#database,
      destroy: () => this.close(),
      admissionTimeoutMs: params.admissionTimeoutMs,
    })
    this.#close = async () => params.sqlite.close(await this.#database)
  }
  get database(): Promise<NativeDBHandle> {
    return this.#database
  }
  get dialect(): NativeDialect {
    return this.#dialect
  }
  #close: () => Promise<void>
  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }
}
