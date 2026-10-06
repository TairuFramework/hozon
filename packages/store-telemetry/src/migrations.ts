import type { MigrationContext } from '@hozon/db'
import type { Migration } from 'kysely/migration'

export function telemetryStoreMigrations(ctx: MigrationContext): Record<string, Migration> {
  return {
    '0-init': {
      async up(db) {
        await db.schema
          .createTable('hozon_spans')
          .addColumn('seq', ctx.types.serial, (column) => {
            const primary = column.primaryKey()
            return ctx.kind === 'sqlite' ? primary.autoIncrement() : primary
          })
          .addColumn('trace_id', ctx.types.text, (column) => column.notNull())
          .addColumn('span_id', ctx.types.text, (column) => column.notNull())
          .addColumn('start_time', ctx.types.double, (column) => column.notNull())
          .addColumn('end_time', ctx.types.double, (column) => column.notNull())
          .addColumn('data', ctx.types.json, (column) => column.notNull())
          .addUniqueConstraint('hozon_spans_trace_span', ['trace_id', 'span_id'])
          .execute()
        await db.schema
          .createIndex('hozon_spans_trace_start_seq')
          .on('hozon_spans')
          .columns(['trace_id', 'start_time', 'seq'])
          .execute()
        await db.schema
          .createIndex('hozon_spans_end_time')
          .on('hozon_spans')
          .column('end_time')
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('hozon_spans').execute()
      },
    },
  }
}
