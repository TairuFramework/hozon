export class SavepointOverlapError extends Error {
  constructor() {
    super('A savepoint is already open in this transaction scope')
    this.name = 'SavepointOverlapError'
  }
}

export class SchemaVersionError extends Error {
  constructor(store: string, unknown: Array<string>) {
    super(
      `Database schema for store "${store}" is newer than this version supports (unknown migrations: ${unknown.join(', ')})`,
    )
    this.name = 'SchemaVersionError'
  }
}

export class InvalidTablePrefixError extends Error {
  constructor(prefix: string) {
    super(`Invalid table prefix "${prefix}": expected /^[a-z][a-z0-9_]{0,30}$/`)
    this.name = 'InvalidTablePrefixError'
  }
}

export class HozonDBClosedError extends Error {
  constructor() {
    super('HozonDB is closed')
    this.name = 'HozonDBClosedError'
  }
}
