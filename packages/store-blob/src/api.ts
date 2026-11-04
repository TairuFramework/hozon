import type { Adapter } from '@hozon/adapter'
import type { BatchReadOptions, Kysely, Selectable, StoreContext } from '@hozon/db'
import { assertBatchSize, chunk, withStoreTransaction } from '@hozon/db'
import { b64uFromUTF, b64uToUTF } from '@sozai/codec'

import { InvalidCursorError } from './errors.js'
import { createRefMethods, upsertReleases } from './refs.js'
import { createSessionMethods } from './sessions.js'
import type { BlobTables } from './tables.js'
import type { BlobChunkInput, BlobEntry, BlobStoreAPI } from './types.js'

function encodeCursor(createdAt: number, blobID: string): string {
  return b64uFromUTF(JSON.stringify([createdAt, blobID]))
}

function decodeCursor(cursor: string): [number, string] {
  try {
    const value: unknown = JSON.parse(b64uToUTF(cursor))
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'number' &&
      Number.isFinite(value[0]) &&
      typeof value[1] === 'string'
    ) {
      return [value[0], value[1]]
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError()
}

// The entry query binds only the IDs.
const ENTRY_BATCH_MAX = 500

type EntryRow = Selectable<BlobTables['blob_entries']>

function toEntry(row: EntryRow): BlobEntry {
  return {
    blobID: row.blob_id,
    contentLength: row.content_length,
    encrypted: row.encrypted === 1,
    keyID: row.key_id,
    chunkSize: row.chunk_size,
    state: row.state,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    contentType: row.content_type,
  }
}

export function createBlobStoreAPI(
  db: Kysely<BlobTables>,
  adapter: Adapter,
  context: StoreContext,
): BlobStoreAPI {
  async function getEntries(
    blobIDs: Array<string>,
    options?: BatchReadOptions,
  ): Promise<Map<string, BlobEntry | null>> {
    const unique = [...new Set(blobIDs)]
    assertBatchSize(unique.length, ENTRY_BATCH_MAX, options?.batchLimit)
    const result = new Map<string, BlobEntry | null>()
    if (unique.length === 0) return result
    const rows = await db
      .selectFrom('blob_entries')
      .selectAll()
      .where('blob_id', 'in', unique)
      .execute()
    for (const id of unique) result.set(id, null)
    for (const row of rows) result.set(row.blob_id, toEntry(row))
    return result
  }

  const entries = context.createLoader<string, BlobEntry>({
    load: (ids) => getEntries(ids),
    maxBatchSize: ENTRY_BATCH_MAX,
  })

  // Flushes pending reads before the write and drops the remembered entry afterwards.
  async function mutate<T>(blobID: string, run: () => Promise<T>): Promise<T> {
    entries.dispatch()
    try {
      return await run()
    } finally {
      entries.clear(blobID)
    }
  }

  async function insertManifest(
    trx: Kysely<BlobTables>,
    blobID: string,
    chunks: Array<BlobChunkInput>,
  ): Promise<void> {
    const rows = chunks.map((item) => ({
      blob_id: blobID,
      index: item.index,
      digest: adapter.encodeBinary(item.digest) as Uint8Array,
    }))
    // Three bindings per row leave each statement below 500 parameters.
    for (const batch of chunk(rows, 166)) {
      await trx
        .insertInto('blob_chunks')
        .values(batch)
        .onConflict((oc) => oc.columns(['blob_id', 'index']).doNothing())
        .execute()
    }
  }

  return {
    ...createRefMethods(db, adapter),
    ...createSessionMethods(db, adapter),
    async setState(blobID, state) {
      await mutate(blobID, async () => {
        await db.updateTable('blob_entries').set({ state }).where('blob_id', '=', blobID).execute()
      })
    },
    async enqueueByteDeletion(blobID, queuedAt = Date.now()) {
      await db
        .insertInto('blob_byte_deletions')
        .values({ blob_id: blobID, queued_at: queuedAt })
        .onConflict((oc) => oc.column('blob_id').doUpdateSet({ queued_at: queuedAt }))
        .execute()
    },
    async listByteDeletions({ limit = 100 } = {}) {
      assertBatchSize(limit, 500)
      if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid limit')
      const rows = await db
        .selectFrom('blob_byte_deletions')
        .selectAll()
        .orderBy('queued_at', 'asc')
        .orderBy('blob_id', 'asc')
        .limit(limit)
        .execute()
      return rows.map((row) => ({ blobID: row.blob_id, queuedAt: row.queued_at }))
    },
    async deleteByteDeletion(blobID) {
      await db.deleteFrom('blob_byte_deletions').where('blob_id', '=', blobID).execute()
    },
    async insertEntry(entry, chunks) {
      return mutate(entry.blobID, async () => {
        await withStoreTransaction(db, async (trx) => {
          const inserted = await trx
            .insertInto('blob_entries')
            .values({
              blob_id: entry.blobID,
              content_length: entry.contentLength,
              encrypted: entry.encrypted ? 1 : 0,
              key_id: entry.keyID ?? null,
              chunk_size: entry.chunkSize,
              state: entry.state,
              pinned: entry.pinned ? 1 : 0,
              created_at: entry.createdAt,
              content_type: entry.contentType ?? null,
            })
            .onConflict((oc) => oc.column('blob_id').doNothing())
            .returning('blob_id')
            .execute()
          if (inserted.length > 0) await upsertReleases(trx, [entry.blobID])
          await insertManifest(trx, entry.blobID, chunks)
        })
      })
    },
    getEntry: (blobID) => entries.load(blobID),
    getEntries,
    async getChunkDigests(blobID) {
      const rows = await db
        .selectFrom('blob_chunks')
        .select('digest')
        .where('blob_id', '=', blobID)
        .orderBy('index', 'asc')
        .execute()
      return rows.map((row) => row.digest)
    },
    async setPinned(blobID, pinned) {
      return mutate(blobID, async () => {
        await withStoreTransaction(db, async (trx) => {
          await trx
            .updateTable('blob_entries')
            .set({ pinned: pinned ? 1 : 0 })
            .where('blob_id', '=', blobID)
            .execute()
          if (!pinned) await upsertReleases(trx, [blobID])
        })
      })
    },
    async deleteEntry(blobID) {
      return mutate(blobID, async () => {
        await withStoreTransaction(db, async (trx) => {
          await trx.deleteFrom('blob_fetch_sessions').where('blob_id', '=', blobID).execute()
          await trx.deleteFrom('blob_chunks').where('blob_id', '=', blobID).execute()
          await trx.deleteFrom('blob_entries').where('blob_id', '=', blobID).execute()
        })
      })
    },
    async listEntries(params) {
      const { limit, cursor } = params
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('Invalid limit: must be an integer between 1 and 1000')
      }
      let query = db.selectFrom('blob_entries').selectAll()
      if (cursor !== undefined) {
        const [createdAt, blobID] = decodeCursor(cursor)
        query = query.where((eb) =>
          eb.or([
            eb('created_at', '>', createdAt),
            eb.and([eb('created_at', '=', createdAt), eb('blob_id', '>', blobID)]),
          ]),
        )
      }
      const rows = await query
        .orderBy('created_at', 'asc')
        .orderBy('blob_id', 'asc')
        .limit(limit + 1)
        .execute()
      const page = rows.slice(0, limit)
      const entries = page.map(toEntry)
      const last = page[page.length - 1]
      const nextCursor =
        rows.length > limit && last !== undefined
          ? encodeCursor(last.created_at, last.blob_id)
          : null
      return { entries, nextCursor }
    },
    async promoteEntry(entry, chunks) {
      return mutate(entry.blobID, async () => {
        await withStoreTransaction(db, async (trx) => {
          let lock = trx
            .selectFrom('blob_entries')
            .select('blob_id')
            .where('blob_id', '=', entry.blobID)
          if (adapter.kind === 'postgres') lock = lock.forUpdate()
          await lock.executeTakeFirst()
          const values = {
            content_length: entry.contentLength,
            encrypted: entry.encrypted ? 1 : 0,
            key_id: entry.keyID ?? null,
            chunk_size: entry.chunkSize,
            state: 'local' as const,
            content_type: entry.contentType ?? null,
          }
          await trx
            .insertInto('blob_entries')
            .values({
              blob_id: entry.blobID,
              pinned: entry.pinned ? 1 : 0,
              created_at: entry.createdAt,
              ...values,
            })
            .onConflict((oc) => oc.column('blob_id').doUpdateSet(values))
            .execute()
          await trx.deleteFrom('blob_fetch_sessions').where('blob_id', '=', entry.blobID).execute()
          await trx.deleteFrom('blob_chunks').where('blob_id', '=', entry.blobID).execute()
          await insertManifest(trx, entry.blobID, chunks)
          await trx.deleteFrom('blob_byte_deletions').where('blob_id', '=', entry.blobID).execute()
          await upsertReleases(trx, [entry.blobID])
        })
      })
    },
    async fillContentType(blobID, contentType) {
      return mutate(blobID, async () => {
        await db
          .updateTable('blob_entries')
          .set({ content_type: contentType })
          .where('blob_id', '=', blobID)
          .where('content_type', 'is', null)
          .execute()
      })
    },
  }
}
