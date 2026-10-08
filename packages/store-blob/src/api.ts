import type { Adapter } from '@hozon/adapter'
import type { Kysely } from '@hozon/db'
import { chunk, withStoreTransaction } from '@hozon/db'

import type { BlobTables } from './tables.js'
import type { BlobChunkInput, BlobEntry, BlobStoreAPI } from './types.js'

function encodeCursor(createdAt: number, blobID: string): string {
  const binary = Array.from(new TextEncoder().encode(JSON.stringify([createdAt, blobID])), (byte) =>
    String.fromCharCode(byte),
  ).join('')
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeCursor(cursor: string): [number, string] {
  try {
    const binary = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
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
  throw new Error('Invalid cursor')
}

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
            content_type: entry.contentType ?? null,
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
            contentType: row.content_type,
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
        await trx.deleteFrom('blob_transfer_sessions').where('blob_id', '=', blobID).execute()
        await trx.deleteFrom('blob_transfers').where('blob_id', '=', blobID).execute()
        await trx.deleteFrom('blob_chunks').where('blob_id', '=', blobID).execute()
        await trx.deleteFrom('blob_entries').where('blob_id', '=', blobID).execute()
      })
    },
    async beginTransfer(blobID, chunkSize, chunks, stagingID) {
      await withStoreTransaction(db, async (trx) => {
        let query = trx
          .selectFrom('blob_entries')
          .select(['blob_id', 'chunk_size'])
          .where('blob_id', '=', blobID)
        if (adapter.kind === 'postgres') query = query.forUpdate()
        const entry = await query.executeTakeFirst()
        if (entry === undefined) throw new Error(`Blob entry ${blobID} not found`)
        if (entry.chunk_size !== chunkSize) {
          const manifest = await trx
            .selectFrom('blob_chunks')
            .select('index')
            .where('blob_id', '=', blobID)
            .executeTakeFirst()
          if (manifest !== undefined) {
            throw new Error(`Cannot change chunk size for blob ${blobID}: manifest already exists`)
          }
        }
        await trx
          .updateTable('blob_entries')
          .set({ chunk_size: chunkSize, state: 'partial' })
          .where('blob_id', '=', blobID)
          .execute()
        await insertManifest(trx, blobID, chunks)
        const existing = await trx
          .selectFrom('blob_transfer_sessions')
          .select('staging_id')
          .where('blob_id', '=', blobID)
          .executeTakeFirst()
        // A new staging area holds none of the previous session's chunks.
        if (existing !== undefined && existing.staging_id !== stagingID) {
          await trx.deleteFrom('blob_transfers').where('blob_id', '=', blobID).execute()
        }
        const updatedAt = Date.now()
        await trx
          .insertInto('blob_transfer_sessions')
          .values({ blob_id: blobID, staging_id: stagingID, updated_at: updatedAt })
          .onConflict((oc) =>
            oc.column('blob_id').doUpdateSet({ staging_id: stagingID, updated_at: updatedAt }),
          )
          .execute()
      })
    },
    async recordTransferChunk(blobID, index) {
      await withStoreTransaction(db, async (trx) => {
        const entry = await trx
          .selectFrom('blob_entries')
          .select('blob_id')
          .where('blob_id', '=', blobID)
          .executeTakeFirst()
        if (entry === undefined) throw new Error(`Blob entry ${blobID} not found`)
        const chunk = await trx
          .selectFrom('blob_chunks')
          .select('index')
          .where('blob_id', '=', blobID)
          .where('index', '=', index)
          .executeTakeFirst()
        if (chunk === undefined) throw new Error(`Blob chunk ${blobID} at index ${index} not found`)
        await trx
          .insertInto('blob_transfers')
          .values({ blob_id: blobID, index })
          .onConflict((oc) => oc.columns(['blob_id', 'index']).doNothing())
          .execute()
        await trx
          .updateTable('blob_transfer_sessions')
          .set({ updated_at: Date.now() })
          .where('blob_id', '=', blobID)
          .execute()
      })
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
        await trx.deleteFrom('blob_transfer_sessions').where('blob_id', '=', blobID).execute()
      })
    },
    async getTransfer(blobID) {
      const session = await db
        .selectFrom('blob_transfer_sessions')
        .select(['staging_id', 'updated_at'])
        .where('blob_id', '=', blobID)
        .executeTakeFirst()
      if (session === undefined) return null
      const rows = await db
        .selectFrom('blob_transfers')
        .select('index')
        .where('blob_id', '=', blobID)
        .orderBy('index', 'asc')
        .execute()
      return {
        stagingID: session.staging_id,
        updatedAt: session.updated_at,
        presentChunks: rows.map((row) => row.index),
      }
    },
    async getTransferByStagingID(stagingID) {
      const row = await db
        .selectFrom('blob_transfer_sessions')
        .select(['blob_id', 'updated_at'])
        .where('staging_id', '=', stagingID)
        .executeTakeFirst()
      return row === undefined ? null : { blobID: row.blob_id, updatedAt: row.updated_at }
    },
    async touchTransfer(blobID) {
      await db
        .updateTable('blob_transfer_sessions')
        .set({ updated_at: Date.now() })
        .where('blob_id', '=', blobID)
        .execute()
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
      const entries: Array<BlobEntry> = page.map((row) => ({
        blobID: row.blob_id,
        contentLength: row.content_length,
        encrypted: row.encrypted === 1,
        keyID: row.key_id,
        chunkSize: row.chunk_size,
        state: row.state,
        pinned: row.pinned === 1,
        createdAt: row.created_at,
        contentType: row.content_type,
      }))
      const last = page[page.length - 1]
      const nextCursor =
        rows.length > limit && last !== undefined
          ? encodeCursor(last.created_at, last.blob_id)
          : null
      return { entries, nextCursor }
    },
    async promoteEntry(entry, chunks) {
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
        await trx.deleteFrom('blob_transfer_sessions').where('blob_id', '=', entry.blobID).execute()
        await trx.deleteFrom('blob_transfers').where('blob_id', '=', entry.blobID).execute()
        await trx.deleteFrom('blob_chunks').where('blob_id', '=', entry.blobID).execute()
        await insertManifest(trx, entry.blobID, chunks)
      })
    },
    async resetTransfer(blobID) {
      await withStoreTransaction(db, async (trx) => {
        let lock = trx.selectFrom('blob_entries').select('blob_id').where('blob_id', '=', blobID)
        if (adapter.kind === 'postgres') lock = lock.forUpdate()
        const entry = await lock.executeTakeFirst()
        if (entry === undefined) return
        await trx.deleteFrom('blob_transfer_sessions').where('blob_id', '=', blobID).execute()
        await trx.deleteFrom('blob_transfers').where('blob_id', '=', blobID).execute()
        await trx.deleteFrom('blob_chunks').where('blob_id', '=', blobID).execute()
        await trx
          .updateTable('blob_entries')
          .set({ state: 'remote-only' })
          .where('blob_id', '=', blobID)
          .execute()
      })
    },
  }
}
