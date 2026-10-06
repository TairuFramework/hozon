import type { MigrationContext } from '@hozon/db'
import type { Migration } from 'kysely/migration'

export function logStoreMigrations(ctx: MigrationContext): Record<string, Migration> {
  return {
    '0-init': {
      async up(db) {
        await db.schema
          .createTable('hozon_logs')
          .addColumn('seq', ctx.types.serial, (column) => {
            const primary = column.primaryKey()
            return ctx.kind === 'sqlite' ? primary.autoIncrement() : primary
          })
          .addColumn('timestamp', ctx.types.double, (column) => column.notNull())
          .addColumn('level', ctx.types.text, (column) => column.notNull())
          .addColumn('category', ctx.types.text, (column) => column.notNull())
          .addColumn('trace_id', ctx.types.text)
          .addColumn('span_id', ctx.types.text)
          .addColumn('data', ctx.types.json, (column) => column.notNull())
          .execute()
        await db.schema
          .createIndex('hozon_logs_timestamp')
          .on('hozon_logs')
          .column('timestamp')
          .execute()
        await db.schema
          .createIndex('hozon_logs_trace_timestamp_seq')
          .on('hozon_logs')
          .columns(['trace_id', 'timestamp', 'seq'])
          .execute()
        await db.schema
          .createIndex('hozon_logs_level_timestamp')
          .on('hozon_logs')
          .columns(['level', 'timestamp'])
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('hozon_logs').execute()
      },
    },
  }
}
