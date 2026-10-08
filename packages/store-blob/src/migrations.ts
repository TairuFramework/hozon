import type { Migration, MigrationContext } from '@hozon/db'

export function blobStoreMigrations(ctx: MigrationContext): Record<string, Migration> {
  return {
    '0-init': {
      async up(db) {
        await db.schema
          .createTable('blob_entries')
          .addColumn('blob_id', ctx.types.text, (column) => column.notNull().primaryKey())
          // Byte lengths and epoch milliseconds can exceed int32.
          .addColumn('content_length', ctx.types.bigint, (column) => column.notNull())
          .addColumn('encrypted', 'integer', (column) => column.notNull().defaultTo(0))
          .addColumn('key_id', ctx.types.text)
          .addColumn('chunk_size', 'integer', (column) => column.notNull())
          .addColumn('state', ctx.types.text, (column) => column.notNull())
          .addColumn('pinned', 'integer', (column) => column.notNull().defaultTo(0))
          .addColumn('created_at', ctx.types.bigint, (column) => column.notNull())
          .execute()
        await db.schema
          .createTable('blob_chunks')
          .addColumn('blob_id', ctx.types.text, (column) => column.notNull())
          .addColumn('index', 'integer', (column) => column.notNull())
          .addColumn('digest', ctx.types.binary, (column) => column.notNull())
          .addPrimaryKeyConstraint(`${ctx.tablePrefix}_blob_chunks_pkey`, ['blob_id', 'index'])
          .addForeignKeyConstraint(
            `${ctx.tablePrefix}_blob_chunks_entry_fkey`,
            ['blob_id'],
            'blob_entries',
            ['blob_id'],
            (constraint) => constraint.onDelete('cascade'),
          )
          .execute()
        await db.schema
          .createTable('blob_transfers')
          .addColumn('blob_id', ctx.types.text, (column) => column.notNull())
          .addColumn('index', 'integer', (column) => column.notNull())
          .addPrimaryKeyConstraint(`${ctx.tablePrefix}_blob_transfers_pkey`, ['blob_id', 'index'])
          .addForeignKeyConstraint(
            `${ctx.tablePrefix}_blob_transfers_chunk_fkey`,
            ['blob_id', 'index'],
            'blob_chunks',
            ['blob_id', 'index'],
            (constraint) => constraint.onDelete('cascade'),
          )
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('blob_transfers').execute()
        await db.schema.dropTable('blob_chunks').execute()
        await db.schema.dropTable('blob_entries').execute()
      },
    },
    '1-sessions': {
      async up(db) {
        await db.schema
          .alterTable('blob_entries')
          .addColumn('content_type', ctx.types.text)
          .execute()
        await db.schema
          .createTable('blob_transfer_sessions')
          .addColumn('blob_id', ctx.types.text, (column) => column.notNull())
          .addColumn('staging_id', ctx.types.text, (column) => column.notNull().unique())
          .addColumn('updated_at', ctx.types.bigint, (column) => column.notNull())
          .addPrimaryKeyConstraint(`${ctx.tablePrefix}_blob_transfer_sessions_pkey`, ['blob_id'])
          .addForeignKeyConstraint(
            `${ctx.tablePrefix}_blob_transfer_sessions_entry_fkey`,
            ['blob_id'],
            'blob_entries',
            ['blob_id'],
            (constraint) => constraint.onDelete('cascade'),
          )
          .execute()
        // Partial entries predate sessions and cannot be resumed: drop their progress.
        await db
          .deleteFrom('blob_transfers')
          .where(
            'blob_id',
            'in',
            db.selectFrom('blob_entries').select('blob_id').where('state', '=', 'partial'),
          )
          .execute()
        await db
          .deleteFrom('blob_chunks')
          .where(
            'blob_id',
            'in',
            db.selectFrom('blob_entries').select('blob_id').where('state', '=', 'partial'),
          )
          .execute()
        await db
          .updateTable('blob_entries')
          .set({ state: 'remote-only' })
          .where('state', '=', 'partial')
          .execute()
      },
      // The backfill (partial entries reset to remote-only, manifests dropped) is not reversible.
      async down(db) {
        await db.schema.dropTable('blob_transfer_sessions').execute()
        await db.schema.alterTable('blob_entries').dropColumn('content_type').execute()
      },
    },
  }
}
