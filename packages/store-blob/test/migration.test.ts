import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { Kysely } from 'kysely'
import { expect, test } from 'vitest'

import { blobStoreDefinition } from '../src/definition.js'
import { getBlobStore } from '../src/index.js'
import { blobStoreMigrations } from '../src/migrations.js'

type Tables = Record<string, unknown>

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
    expect(await store.getPresentChunkIndexes('p')).toEqual([])
    expect((await store.getEntry('l'))?.state).toBe('local')
    expect(await store.getChunkDigests('l')).toHaveLength(1)
    expect((await store.getEntry('p'))?.contentType).toBeNull()
  } finally {
    await db.close()
  }
})
