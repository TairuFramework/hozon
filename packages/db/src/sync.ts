import type { Adapter } from '@hozon/adapter'
import type { ColumnDefinitionBuilder, Kysely, RawBuilder } from 'kysely'
import { sql } from 'kysely'

import type { MigrationContext, StoreProvider } from './db.js'
import { KeyLockScopeError } from './errors.js'

export type CompareDefinition<Row> = {
  key: Array<keyof Row & string>
  compare: Array<keyof Row & string>
  inclusive?: boolean
  nullsOldest?: boolean
  skipUnchanged?: boolean
  cursor?: never
  tombstones?: never
}

type LockContext = {
  assertActive: () => void
  derive: () => StoreProvider
  db: Kysely<Record<string, unknown>>
  kind: Adapter['kind']
  tablePrefix: string
  tableName: (table: string) => string
}

type LockScope = { parent?: LockScope; keys: Set<string> }
const providerScopes = new WeakMap<StoreProvider, LockScope>()
const savepointScopes = new WeakMap<StoreProvider, Set<LockScope>>()

export function settleSyncProvider(provider: StoreProvider): void {
  const scope = providerScopes.get(provider)
  if (scope) savepointScopes.get(provider.transactionRoot ?? provider)?.delete(scope)
}

const lockContexts = new WeakMap<StoreProvider, LockContext>()
const ownership = new WeakMap<StoreProvider, Map<string, { active: boolean }>>()
const keyLocks = new WeakMap<object, Map<string, Promise<void>>>()

export function bindSyncProvider(
  provider: StoreProvider,
  context: LockContext,
  parent?: StoreProvider,
  savepoint = false,
): void {
  lockContexts.set(provider, context)
  ownership.set(provider, new Map(parent == null ? [] : ownership.get(parent)))
  const parentScope = parent == null ? undefined : providerScopes.get(parent)
  if (savepoint) {
    const scope = { parent: parentScope, keys: new Set<string>() }
    providerScopes.set(provider, scope)
    const root = provider.transactionRoot ?? provider
    let scopes = savepointScopes.get(root)
    if (!scopes) {
      scopes = new Set()
      savepointScopes.set(root, scopes)
    }
    scopes.add(scope)
  } else if (parentScope) {
    providerScopes.set(provider, parentScope)
  }
}

async function withQueue<R>(root: object, key: string, fn: () => Promise<R>): Promise<R> {
  let locks = keyLocks.get(root)
  if (locks == null) {
    locks = new Map()
    keyLocks.set(root, locks)
  }
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  locks.set(key, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

export async function withKeyLock<R>(
  provider: StoreProvider,
  table: string,
  key: ReadonlyArray<string | number>,
  fn: (tx: StoreProvider) => Promise<R>,
): Promise<R> {
  return await withKeyLocks(provider, table, [key], fn)
}

export async function withKeyLocks<R>(
  provider: StoreProvider,
  table: string,
  keys: ReadonlyArray<ReadonlyArray<string | number>>,
  fn: (tx: StoreProvider) => Promise<R>,
): Promise<R> {
  if (!provider.isTransactionBound) {
    return await provider.withTransaction((tx) => withKeyLocks(tx, table, keys, fn))
  }
  const root = provider.transactionRoot ?? provider
  const context = lockContexts.get(provider)
  if (context == null) throw new Error('withKeyLock requires a HozonDB provider')
  context.assertActive()
  const identities = [
    ...new Set(
      keys.map((key) => {
        if (key.some((part) => typeof part === 'number' && !Number.isFinite(part))) {
          throw new Error('Lock keys require finite numbers')
        }
        return JSON.stringify([context.tablePrefix, table, key])
      }),
    ),
  ]
  let lockIDs: Array<string>
  if (context.kind === 'postgres') {
    const ids: Array<bigint> = []
    for (const identity of identities) {
      const result = await sql<{
        id: string
      }>`SELECT (('x' || substr(md5(${identity}::text), 1, 16))::bit(64)::bigint)::text AS id`.execute(
        context.db,
      )
      for (const row of result.rows) ids.push(BigInt(row.id))
    }
    // Order and deduplicate the actual IDs: collisions only add contention.
    lockIDs = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String)
  } else {
    lockIDs = identities.sort()
  }
  const scope = providerScopes.get(provider)
  const ancestors = new Set<LockScope>()
  for (let current = scope; current; current = current.parent) ancestors.add(current)
  const checkScope = (id: string) => {
    for (const reservation of savepointScopes.get(root) ?? []) {
      if (reservation.keys.has(id) && !ancestors.has(reservation)) throw new KeyLockScopeError()
    }
  }
  for (const id of lockIDs) checkScope(id)
  const held = ownership.get(provider)
  const acquired = { active: true }
  const locked = context.derive()
  // biome-ignore lint/style/noNonNullAssertion: derive binds ownership before returning.
  const owned = ownership.get(locked)!
  const acquire = async (index: number): Promise<R> => {
    const id = lockIDs[index]
    if (id === undefined) {
      if (context.kind === 'sqlite' && lockIDs.length > 0) {
        // Even a zero-row DELETE reserves SQLite's writer before the callback reads.
        await sql`DELETE FROM ${sql.table(context.tableName(table))} WHERE 1 = 0`.execute(
          context.db,
        )
      }
      for (const id of lockIDs) {
        checkScope(id)
        for (const ancestor of ancestors) ancestor.keys.add(id)
      }
      context.assertActive()
      return await fn(locked)
    }
    checkScope(id)
    if (held?.get(id)?.active) return await acquire(index + 1)
    return await withQueue(root, id, async () => {
      checkScope(id)
      if (context.kind === 'postgres') {
        await sql`SELECT pg_advisory_xact_lock(${id}::bigint)`.execute(context.db)
      }
      for (const ancestor of ancestors) ancestor.keys.add(id)
      owned.set(id, acquired)
      return await acquire(index + 1)
    })
  }
  try {
    return await acquire(0)
  } finally {
    acquired.active = false
  }
}

export function compareText(
  ctx: MigrationContext,
): (column: ColumnDefinitionBuilder) => ColumnDefinitionBuilder {
  return (column) => (ctx.kind === 'postgres' ? column.modifyEnd(sql`collate "C"`) : column)
}

export async function compareWrite(
  db: Kysely<Record<string, unknown>>,
  table: string,
  row: Record<string, unknown>,
  definition?: CompareDefinition<Record<string, unknown>>,
): Promise<{ changed: boolean }> {
  if (definition == null) throw new Error(`Table "${table}" has no sync declaration`)
  if (definition.key.length === 0 || definition.compare.length === 0) {
    throw new Error('Sync declarations require key and compare columns')
  }
  const columns = Object.keys(row)
  const stored = (column: string) => sql.ref(`${table}.${column}`)
  const incoming = (column: string) => sql.ref(`excluded.${column}`)
  const tuple = (names: Array<string>, ref: (column: string) => RawBuilder<unknown>) =>
    sql`(${sql.join(names.map(ref))})`
  const { compare } = definition
  let predicate: RawBuilder<boolean>
  if (definition.nullsOldest) {
    const alternatives = compare.map((column, index) => {
      const equal = compare
        .slice(0, index)
        .map((previous) => sql`${incoming(previous)} IS NOT DISTINCT FROM ${stored(previous)}`)
      const greater = sql`((${stored(column)} IS NULL AND ${incoming(column)} IS NOT NULL) OR ${incoming(column)} > ${stored(column)})`
      return sql`(${sql.join([...equal, greater], sql` AND `)})`
    })
    if (definition.inclusive) {
      alternatives.push(
        sql`(${sql.join(
          compare.map((column) => sql`${incoming(column)} IS NOT DISTINCT FROM ${stored(column)}`),
          sql` AND `,
        )})`,
      )
    }
    predicate = sql<boolean>`(${sql.join(alternatives, sql` OR `)})`
  } else {
    predicate = sql<boolean>`${tuple(compare, incoming)} ${definition.inclusive ? sql`>=` : sql`>`} ${tuple(compare, stored)}`
  }
  if (definition.skipUnchanged) {
    predicate = sql<boolean>`(${predicate}) AND ${tuple(columns, stored)} IS DISTINCT FROM ${tuple(columns, incoming)}`
  }
  const query = db as Kysely<Record<string, Record<string, unknown>>>
  const updates = Object.fromEntries(columns.map((column) => [column, incoming(column)]))
  const statement = query
    .insertInto(table)
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(definition.key).doUpdateSet(updates).where(predicate),
    )
    .returning(definition.key)
  const compiled = statement.compile()
  if (compiled.parameters.length > 500) {
    throw new Error('compareWrite cannot bind more than 500 parameters')
  }
  const result = await db.executeQuery(compiled)
  return { changed: result.rows.length > 0 }
}
