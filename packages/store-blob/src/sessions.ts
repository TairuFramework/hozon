import type { Adapter } from '@hozon/adapter'
import type { Kysely } from '@hozon/db'
import { chunk, withStoreTransaction } from '@hozon/db'
import { b64uFromUTF, b64uToUTF } from '@sozai/codec'

import { InvalidCursorError } from './errors.js'
import { upsertReleases } from './refs.js'
import type { BlobFetchSessionTable, BlobTables } from './tables.js'
import type { BlobSession, BlobStoreAPI } from './types.js'

type SessionMethods = Pick<
  BlobStoreAPI,
  | 'getSession'
  | 'getSessionByStagingID'
  | 'listSessions'
  | 'putSession'
  | 'markSessionChunk'
  | 'deleteSession'
  | 'deleteSessions'
  | 'touchSession'
  | 'sumSessionContentLength'
>

export function createSessionMethods(db: Kysely<BlobTables>, adapter: Adapter): SessionMethods {
  function sessionQuery() {
    return db
      .selectFrom('blob_fetch_sessions')
      .leftJoin(
        'blob_fetch_chunks',
        'blob_fetch_chunks.staging_id',
        'blob_fetch_sessions.staging_id',
      )
      .selectAll('blob_fetch_sessions')
      .select([
        'blob_fetch_chunks.index as chunk_index',
        'blob_fetch_chunks.digest as chunk_digest',
        'blob_fetch_chunks.present as chunk_present',
      ])
      .orderBy('blob_fetch_chunks.index')
  }
  function toSession(
    rows: Array<
      BlobFetchSessionTable & {
        chunk_index: number | null
        chunk_digest: Uint8Array | null
        chunk_present: number | null
      }
    >,
  ): BlobSession | null {
    const row = rows[0]
    if (row === undefined) return null
    const chunks = rows.flatMap((c) =>
      c.chunk_index === null || c.chunk_digest === null
        ? []
        : [
            {
              index: c.chunk_index,
              digest: c.chunk_digest,
              present: c.chunk_present === 1,
            },
          ],
    )
    return {
      blobID: row.blob_id,
      owner: row.owner,
      stagingID: row.staging_id,
      contentLength: row.content_length,
      chunkSize: row.chunk_size,
      contentType: row.content_type,
      encrypted: row.encrypted === 1,
      keyID: row.key_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      chunks,
      presentChunks: chunks.filter((c) => c.present).map((c) => c.index),
    }
  }
  async function getSessionByStagingID(stagingID: string): Promise<BlobSession | null> {
    return toSession(
      await sessionQuery().where('blob_fetch_sessions.staging_id', '=', stagingID).execute(),
    )
  }
  return {
    async getSession(blobID, owner) {
      return toSession(
        await sessionQuery()
          .where('blob_fetch_sessions.blob_id', '=', blobID)
          .where('blob_fetch_sessions.owner', '=', owner)
          .execute(),
      )
    },
    getSessionByStagingID,
    async listSessions(params) {
      const { limit } = params
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid limit')
      let query = db.selectFrom('blob_fetch_sessions').selectAll()
      if (params.owner !== undefined) query = query.where('owner', '=', params.owner)
      if (params.ownerPrefix !== undefined)
        query = query
          .where('owner', '>=', params.ownerPrefix)
          .where('owner', '<', `${params.ownerPrefix}\x7f`)
      if (params.blobID !== undefined) query = query.where('blob_id', '=', params.blobID)
      if (params.cursor !== undefined) {
        let value: unknown
        try {
          value = JSON.parse(b64uToUTF(params.cursor))
        } catch {
          /* Rejected below. */
        }
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !value.every((v) => typeof v === 'string')
        )
          throw new InvalidCursorError()
        const [owner, blobID] = value as [string, string]
        query = query.where((eb) =>
          eb.or([
            eb('owner', '>', owner),
            eb.and([eb('owner', '=', owner), eb('blob_id', '>', blobID)]),
          ]),
        )
      }
      const rows = await query
        .orderBy('owner')
        .orderBy('blob_id')
        .limit(limit + 1)
        .execute()
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        sessions: (
          await Promise.all(page.map((row) => getSessionByStagingID(row.staging_id)))
        ).filter((session): session is BlobSession => session !== null),
        nextCursor:
          rows.length > limit && last !== undefined
            ? b64uFromUTF(JSON.stringify([last.owner, last.blob_id]))
            : null,
      }
    },
    async putSession(session) {
      await withStoreTransaction(db, async (trx) => {
        const ended = await trx
          .deleteFrom('blob_fetch_sessions')
          .where('blob_id', '=', session.blobID)
          .where('owner', '=', session.owner)
          .returning('blob_id')
          .execute()
        if (ended.length > 0) await upsertReleases(trx, [session.blobID])
        await trx
          .insertInto('blob_fetch_sessions')
          .values({
            blob_id: session.blobID,
            owner: session.owner,
            staging_id: session.stagingID,
            content_length: session.contentLength,
            chunk_size: session.chunkSize,
            content_type: session.contentType,
            encrypted: session.encrypted ? 1 : 0,
            key_id: session.keyID,
            created_at: session.createdAt,
            updated_at: session.updatedAt,
          })
          .execute()
        for (const batch of chunk(session.chunks, 125)) {
          await trx
            .insertInto('blob_fetch_chunks')
            .values(
              batch.map((c) => ({
                staging_id: session.stagingID,
                index: c.index,
                digest: adapter.encodeBinary(c.digest) as Uint8Array,
                present: 0,
              })),
            )
            .execute()
        }
      })
    },
    async markSessionChunk(blobID, owner, index) {
      await withStoreTransaction(db, async (trx) => {
        const row = await trx
          .selectFrom('blob_fetch_sessions')
          .select('staging_id')
          .where('blob_id', '=', blobID)
          .where('owner', '=', owner)
          .executeTakeFirst()
        if (row === undefined) throw new Error(`Blob session ${blobID} for ${owner} not found`)
        const changed = await trx
          .updateTable('blob_fetch_chunks')
          .set({ present: 1 })
          .where('staging_id', '=', row.staging_id)
          .where('index', '=', index)
          .returning('index')
          .execute()
        if (changed.length === 0)
          throw new Error(`Blob session chunk ${blobID} at index ${index} not found`)
        await trx
          .updateTable('blob_fetch_sessions')
          .set({ updated_at: Date.now() })
          .where('blob_id', '=', blobID)
          .where('owner', '=', owner)
          .execute()
      })
    },
    async deleteSession(blobID, owner) {
      await withStoreTransaction(db, async (trx) => {
        await trx
          .deleteFrom('blob_fetch_sessions')
          .where('blob_id', '=', blobID)
          .where('owner', '=', owner)
          .execute()
        await upsertReleases(trx, [blobID])
      })
    },
    async deleteSessions(blobID) {
      await withStoreTransaction(db, async (trx) => {
        await trx.deleteFrom('blob_fetch_sessions').where('blob_id', '=', blobID).execute()
        await upsertReleases(trx, [blobID])
      })
    },
    async touchSession(blobID, owner) {
      await db
        .updateTable('blob_fetch_sessions')
        .set({ updated_at: Date.now() })
        .where('blob_id', '=', blobID)
        .where('owner', '=', owner)
        .execute()
    },
    async sumSessionContentLength() {
      const row = await db
        .selectFrom('blob_fetch_sessions')
        .select((eb) => eb.fn.sum<number>('content_length').as('total'))
        .executeTakeFirstOrThrow()
      return Number(row.total ?? 0)
    },
  }
}
