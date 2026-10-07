import type { Adapter } from '@hozon/adapter'
import { chunk, withStoreTransaction } from '@hozon/db'
import type { Kysely } from 'kysely'

import type { BlobTables } from './tables.js'
import type { BlobChunkInput, BlobStoreAPI } from './types.js'

export function createBlobStoreAPI(db: Kysely<BlobTables>, adapter: Adapter): BlobStoreAPI {
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
    async insertEntry(entry, chunks) {
      await withStoreTransaction(db, async (trx) => {
        await trx
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
          })
          .onConflict((oc) => oc.column('blob_id').doNothing())
          .execute()
        await insertManifest(trx, entry.blobID, chunks)
      })
    },
    async getEntry(blobID) {
      const row = await db
        .selectFrom('blob_entries')
        .selectAll()
        .where('blob_id', '=', blobID)
        .executeTakeFirst()
      return row === undefined
        ? null
        : {
            blobID: row.blob_id,
            contentLength: row.content_length,
            encrypted: row.encrypted === 1,
            keyID: row.key_id,
            chunkSize: row.chunk_size,
            state: row.state,
            pinned: row.pinned === 1,
            createdAt: row.created_at,
          }
    },
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
      await db
        .updateTable('blob_entries')
        .set({ pinned: pinned ? 1 : 0 })
        .where('blob_id', '=', blobID)
        .execute()
    },
    async deleteEntry(blobID) {
      await withStoreTransaction(db, async (trx) => {
        await trx.deleteFrom('blob_transfers').where('blob_id', '=', blobID).execute()
        await trx.deleteFrom('blob_chunks').where('blob_id', '=', blobID).execute()
        await trx.deleteFrom('blob_entries').where('blob_id', '=', blobID).execute()
      })
    },
    async beginTransfer(blobID, chunkSize, chunks) {
      await withStoreTransaction(db, async (trx) => {
        const entry = await trx
          .selectFrom('blob_entries')
          .select('blob_id')
          .where('blob_id', '=', blobID)
          .executeTakeFirst()
        if (entry === undefined) throw new Error(`Blob entry ${blobID} not found`)
        await trx
          .updateTable('blob_entries')
          .set({ chunk_size: chunkSize, state: 'partial' })
          .where('blob_id', '=', blobID)
          .execute()
        await insertManifest(trx, blobID, chunks)
      })
    },
    async recordTransferChunk(blobID, index) {
      await db
        .insertInto('blob_transfers')
        .values({ blob_id: blobID, index })
        .onConflict((oc) => oc.columns(['blob_id', 'index']).doNothing())
        .execute()
    },
    async getPresentChunkIndexes(blobID) {
      const rows = await db
        .selectFrom('blob_transfers')
        .select('index')
        .where('blob_id', '=', blobID)
        .orderBy('index', 'asc')
        .execute()
      return rows.map((row) => row.index)
    },
    async finalizeTransfer(blobID) {
      await withStoreTransaction(db, async (trx) => {
        const entry = await trx
          .selectFrom('blob_entries')
          .select('blob_id')
          .where('blob_id', '=', blobID)
          .executeTakeFirst()
        if (entry === undefined) throw new Error(`Blob entry ${blobID} not found`)
        const manifest = await trx
          .selectFrom('blob_chunks')
          .select('index')
          .where('blob_id', '=', blobID)
          .execute()
        const present = await trx
          .selectFrom('blob_transfers')
          .select('index')
          .where('blob_id', '=', blobID)
          .execute()
        const presentSet = new Set(present.map((row) => row.index))
        const missing = manifest.filter((row) => !presentSet.has(row.index))
        if (missing.length > 0) {
          throw new Error(`Cannot finalize transfer ${blobID}: ${missing.length} chunk(s) missing`)
        }
        await trx
          .updateTable('blob_entries')
          .set({ state: 'local' })
          .where('blob_id', '=', blobID)
          .execute()
        await trx.deleteFrom('blob_transfers').where('blob_id', '=', blobID).execute()
      })
    },
  }
}
