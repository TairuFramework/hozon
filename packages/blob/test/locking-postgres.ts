import { randomUUID } from 'node:crypto'
import { MemoryBlobBackend } from '@hozon/blob-backend'
import { HozonDB, Kysely, sql } from '@hozon/db'
import { PostgresAdapter } from '@hozon/postgres'
import { blobStoreDefinition, getBlobStore } from '@hozon/store-blob'

import { createBlobService } from '../src/index.js'

type PostgresServer = { url: string; stop(): Promise<void> }

export async function startBlobPostgres(): Promise<PostgresServer> {
  if (process.env.HOZON_BLOB_POSTGRES !== '1')
    throw new Error('Postgres tests require explicit opt-in')
  // Resolve the existing integration harness without extending this package's TypeScript root.
  const harnessURL = new URL('../../../tests/integration/src/backends.ts', import.meta.url).href
  const harness = (await import(harnessURL)) as {
    startPostgres(): Promise<PostgresServer | null>
  }
  const server = await harness.startPostgres()
  if (server == null) throw new Error('Postgres was explicitly enabled but no server is available')
  return server
}

export async function createPostgresService(url: string) {
  const schema = `blob_${randomUUID().replaceAll('-', '')}`
  const admin = new Kysely<Record<string, unknown>>({
    dialect: new PostgresAdapter({ url }).dialect,
  })
  await admin.schema.createSchema(schema).execute()
  const db = new HozonDB({
    adapter: new PostgresAdapter({
      url,
      options: { max: 6, connection: { search_path: schema, statement_timeout: 10000 } },
    }),
  })
  db.register(blobStoreDefinition)
  db.register<{ rows: { id: number } }, RowsAPI>({
    name: 'rows',
    migrations: {
      '0-init': {
        async up(query) {
          await query.schema
            .createTable('rows')
            .addColumn('id', 'integer', (column) => column.primaryKey())
            .execute()
          await query.insertInto('rows').values({ id: 1 }).execute()
        },
      },
    },
    createAPI: (query) => ({
      async lock() {
        await query.selectFrom('rows').select('id').where('id', '=', 1).forUpdate().execute()
      },
      async deadlock() {
        await sql`do $$ begin raise exception using errcode = '40P01', message = 'deadlock retry probe'; end $$`.execute(
          query,
        )
      },
    }),
  })
  await db.migrate()
  const backend = new MemoryBlobBackend()
  const service = createBlobService({ db, backend })
  return {
    db,
    backend,
    service,
    store: await getBlobStore(db),
    async cleanup() {
      await db.close()
      await admin.schema.dropSchema(schema).cascade().execute()
      await admin.destroy()
    },
  }
}

export type RowsAPI = { lock(): Promise<void>; deadlock(): Promise<void> }
