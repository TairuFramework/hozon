import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { Kysely } from 'kysely'
import { expect, test } from 'vitest'

import { blobStoreDefinition } from '../src/definition.js'
import { getBlobStore } from '../src/index.js'
import { blobStoreMigrations } from '../src/migrations.js'

type Tables = Record<string, Record<string, unknown>>

test('holder migration leaves existing entries unreleased and drops only its own tables', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  db.register<Tables, Kysely<Tables>>({ name: 'raw', migrations: {}, createAPI: (query) => query })
  try {
    const raw = await db.getStore<Kysely<Tables>>('raw')
    const migrations = blobStoreMigrations({
      tablePrefix: 'hozon',
      kind: adapter.kind,
      types: adapter.types,
      functions: adapter.functions,
    })
    for (const name of ['0-init', '1-sessions', '2-byte-deletions']) {
      const migration = migrations[name]
      if (migration === undefined) throw new Error('Missing migration')
      await migration.up(raw)
    }
    await raw
      .insertInto('blob_entries')
      .values({ blob_id: 'old', content_length: 8, chunk_size: 4, state: 'local', created_at: 1 })
      .execute()
    const migration = migrations['3-holders']
    if (migration?.down === undefined) throw new Error('Missing holder migration')
    await migration.up(raw)
    expect(await raw.selectFrom('blob_releases').selectAll().execute()).toEqual([])
    await raw
      .insertInto('blob_refs')
      .values({ blob_id: 'absent', kind: 'doc', key: 'owner-a', created_at: 1 })
      .execute()
    const names = (await raw.introspection.getTables()).map((t) => t.name)
    expect(names).toContain('hozon_blob_refs')
    expect(names).toContain('hozon_blob_releases')
    await migration.down(raw)
    expect((await raw.introspection.getTables()).map((t) => t.name)).not.toContain(
      'hozon_blob_refs',
    )
    expect(adapter.database.prepare('SELECT blob_id FROM hozon_blob_entries').all()).toEqual([
      { blob_id: 'old' },
    ])
    expect(await raw.selectFrom('blob_byte_deletions').selectAll().execute()).toEqual([])
  } finally {
    await db.close()
  }
})

test('1-sessions backfills partial entries to remote-only and keeps local ones', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  db.register<Tables, Kysely<Tables>>({ name: 'raw', migrations: {}, createAPI: (query) => query })
  try {
    const raw = await db.getStore<Kysely<Tables>>('raw')
    const init = blobStoreMigrations({
      tablePrefix: 'hozon',
      kind: adapter.kind,
      types: adapter.types,
      functions: adapter.functions,
    })['0-init']
    if (init === undefined) throw new Error('Expected initial migration')
    await init.up(raw)
    adapter.database.exec(
      `CREATE TABLE hozon_blob_migration (name text PRIMARY KEY, timestamp text NOT NULL);
       INSERT INTO hozon_blob_migration VALUES ('0-init', '2026-01-01')`,
    )
    const base = { encrypted: 0, chunk_size: 4, pinned: 0, created_at: 1, content_length: 8 }
    await raw
      .insertInto('blob_entries')
      .values([
        { blob_id: 'p', state: 'partial', ...base },
        { blob_id: 'l', state: 'local', ...base },
      ])
      .execute()
    const digest = new Uint8Array([1, 2])
    await raw
      .insertInto('blob_chunks')
      .values([
        { blob_id: 'p', index: 0, digest },
        { blob_id: 'l', index: 0, digest },
      ])
      .execute()
    await raw.insertInto('blob_transfers').values({ blob_id: 'p', index: 0 }).execute()

    db.register(blobStoreDefinition)
    const store = await getBlobStore(db)
    expect((await store.getEntry('p'))?.state).toBe('remote-only')
    expect(await store.getChunkDigests('p')).toEqual([])
    expect((await store.listSessions({ blobID: 'p', limit: 10 })).sessions).toEqual([])
    expect((await store.getEntry('l'))?.state).toBe('local')
    expect(await store.getChunkDigests('l')).toHaveLength(1)
    expect((await store.getEntry('p'))?.contentType).toBeNull()
  } finally {
    await db.close()
  }
})

test('byte deletion migration creates and drops an independent journal', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  db.register<Tables, Kysely<Tables>>({ name: 'raw', migrations: {}, createAPI: (query) => query })
  try {
    const raw = await db.getStore<Kysely<Tables>>('raw')
    const migration = blobStoreMigrations({
      tablePrefix: 'hozon',
      kind: adapter.kind,
      types: adapter.types,
      functions: adapter.functions,
    })['2-byte-deletions']
    expect(migration).toBeDefined()
    if (migration === undefined || migration.down === undefined)
      throw new Error('Missing migration')
    await migration.up(raw)
    await raw
      .insertInto('blob_byte_deletions')
      .values({ blob_id: 'absent', queued_at: 1 })
      .execute()
    expect(await raw.selectFrom('blob_byte_deletions').selectAll().execute()).toEqual([
      { blob_id: 'absent', queued_at: 1 },
    ])
    await migration.down(raw)
    expect((await raw.introspection.getTables()).map((table) => table.name)).not.toContain(
      'hozon_blob_byte_deletions',
    )
  } finally {
    await db.close()
  }
})

test('fetch session migration discards unverified legacy transfers and restores old shapes on down', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  db.register<Tables, Kysely<Tables>>({ name: 'raw', migrations: {}, createAPI: (query) => query })
  try {
    const raw = await db.getStore<Kysely<Tables>>('raw')
    const migrations = blobStoreMigrations({
      tablePrefix: 'hozon',
      kind: adapter.kind,
      types: adapter.types,
      functions: adapter.functions,
    })
    for (const name of ['0-init', '1-sessions']) {
      const migration = migrations[name]
      if (migration === undefined) throw new Error('Missing migration')
      await migration.up(raw)
    }
    await raw
      .insertInto('blob_entries')
      .values([
        { blob_id: 'p', content_length: 8, chunk_size: 4, state: 'partial', created_at: 1 },
        { blob_id: 'l', content_length: 8, chunk_size: 4, state: 'local', created_at: 1 },
      ])
      .execute()
    await raw
      .insertInto('blob_chunks')
      .values([
        { blob_id: 'p', index: 0, digest: new Uint8Array([1]) },
        { blob_id: 'l', index: 0, digest: new Uint8Array([2]) },
      ])
      .execute()
    await raw.insertInto('blob_transfers').values({ blob_id: 'p', index: 0 }).execute()
    await raw
      .insertInto('blob_transfer_sessions')
      .values({ blob_id: 'p', staging_id: 't-old', updated_at: 1 })
      .execute()
    for (const name of ['2-byte-deletions', '3-holders', '4-fetch-sessions']) {
      const migration = migrations[name]
      if (migration === undefined) throw new Error(`Missing migration ${name}`)
      await migration.up(raw)
    }
    expect(
      await raw
        .selectFrom('blob_entries')
        .select(['blob_id', 'state'])
        .orderBy('blob_id')
        .execute(),
    ).toEqual([
      { blob_id: 'l', state: 'local' },
      { blob_id: 'p', state: 'remote-only' },
    ])
    expect(await raw.selectFrom('blob_chunks').select('blob_id').execute()).toEqual([
      { blob_id: 'l' },
    ])
    expect(await raw.selectFrom('blob_fetch_sessions').selectAll().execute()).toEqual([])
    expect(await raw.selectFrom('blob_fetch_chunks').selectAll().execute()).toEqual([])
    expect(await raw.selectFrom('blob_releases').selectAll().execute()).toEqual([])
    const names = (await raw.introspection.getTables()).map((t) => t.name)
    expect(names).not.toContain('hozon_blob_transfers')
    expect(names).not.toContain('hozon_blob_transfer_sessions')
    const migration = migrations['4-fetch-sessions']
    if (migration?.down === undefined) throw new Error('Missing down migration')
    await migration.down(raw)
    const tables = await raw.introspection.getTables()
    expect(
      tables.find((t) => t.name === 'hozon_blob_transfers')?.columns.map((c) => c.name),
    ).toEqual(['blob_id', 'index'])
    expect(
      tables.find((t) => t.name === 'hozon_blob_transfer_sessions')?.columns.map((c) => c.name),
    ).toEqual(['blob_id', 'staging_id', 'updated_at'])
    expect(tables.map((t) => t.name)).not.toContain('hozon_blob_fetch_sessions')
    expect(tables.map((t) => t.name)).not.toContain('hozon_blob_fetch_chunks')
    expect(await raw.selectFrom('blob_transfers').selectAll().execute()).toEqual([])
    expect(await raw.selectFrom('blob_transfer_sessions').selectAll().execute()).toEqual([])
    await raw
      .insertInto('blob_transfer_sessions')
      .values({ blob_id: 'p', staging_id: 't-restored', updated_at: 2 })
      .execute()
    await raw
      .insertInto('blob_chunks')
      .values({ blob_id: 'p', index: 0, digest: new Uint8Array([1]) })
      .execute()
    await raw.insertInto('blob_transfers').values({ blob_id: 'p', index: 0 }).execute()
    await raw.deleteFrom('blob_entries').where('blob_id', '=', 'p').execute()
    expect(await raw.selectFrom('blob_transfers').selectAll().execute()).toEqual([])
    expect(await raw.selectFrom('blob_transfer_sessions').selectAll().execute()).toEqual([])
  } finally {
    await db.close()
  }
})
