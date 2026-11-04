import type { Adapter } from '@hozon/adapter'
import type { Kysely } from '@hozon/db'
import { assertBatchSize, chunk, withStoreTransaction } from '@hozon/db'
import { b64uFromUTF, b64uToUTF } from '@sozai/codec'

import { InvalidCursorError } from './errors.js'
import type { BlobRefTable, BlobTables } from './tables.js'
import type { BlobStoreAPI } from './types.js'

export async function upsertReleases(
  db: Kysely<BlobTables>,
  blobIDs: Array<string>,
  releasedAt = Date.now(),
): Promise<void> {
  for (const batch of chunk([...new Set(blobIDs)], 500)) {
    const entries = await db
      .selectFrom('blob_entries')
      .select('blob_id')
      .where('blob_id', 'in', batch)
      .execute()
    for (const rows of chunk(entries, 250)) {
      await db
        .insertInto('blob_releases')
        .values(rows.map((row) => ({ blob_id: row.blob_id, released_at: releasedAt })))
        .onConflict((oc) =>
          oc.column('blob_id').doUpdateSet({ released_at: (eb) => eb.ref('excluded.released_at') }),
        )
        .execute()
    }
  }
}

function toRef(row: BlobRefTable) {
  return { blobID: row.blob_id, kind: row.kind, key: row.key, createdAt: row.created_at }
}

type RefMethods = Pick<
  BlobStoreAPI,
  | 'insertRefs'
  | 'deleteRefs'
  | 'deleteRefsByHolder'
  | 'countRefs'
  | 'listRefs'
  | 'findRefs'
  | 'upsertReleases'
  | 'listReleases'
  | 'deleteRelease'
>

export function createRefMethods(db: Kysely<BlobTables>, adapter: Adapter): RefMethods {
  return {
    async insertRefs(refs) {
      const now = Date.now()
      await withStoreTransaction(db, async (trx) => {
        for (const batch of chunk(refs, 125)) {
          await trx
            .insertInto('blob_refs')
            .values(
              batch.map((ref) => ({
                blob_id: ref.blobID,
                kind: ref.kind,
                key: ref.key,
                created_at: now,
              })),
            )
            .onConflict((oc) => oc.columns(['blob_id', 'kind', 'key']).doNothing())
            .execute()
        }
      })
    },
    async deleteRefs(refs) {
      return await withStoreTransaction(db, async (trx) => {
        const removed: Array<string> = []
        for (const batch of chunk(refs, 166)) {
          const rows = await trx
            .deleteFrom('blob_refs')
            .where((eb) =>
              eb.or(
                batch.map((ref) =>
                  eb.and([
                    eb('blob_id', '=', ref.blobID),
                    eb('kind', '=', ref.kind),
                    eb('key', '=', ref.key),
                  ]),
                ),
              ),
            )
            .returning('blob_id')
            .execute()
          removed.push(...rows.map((r) => r.blob_id))
        }
        await upsertReleases(trx, removed)
        return removed
      })
    },
    async deleteRefsByHolder(selector) {
      return await withStoreTransaction(db, async (trx) => {
        let query = trx.deleteFrom('blob_refs').where('kind', '=', selector.kind)
        if ('key' in selector) query = query.where('key', '=', selector.key)
        else
          query = query
            .where('key', '>=', selector.keyPrefix)
            .where('key', '<', `${selector.keyPrefix}\x7f`)
        const rows = await query.returning('blob_id').execute()
        const removed = rows.map((r) => r.blob_id)
        await upsertReleases(trx, removed)
        return removed
      })
    },
    async countRefs(blobID) {
      const row = await db
        .selectFrom('blob_refs')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('blob_id', '=', blobID)
        .executeTakeFirstOrThrow()
      return Number(row.count)
    },
    async listRefs(blobID) {
      const rows = await db
        .selectFrom('blob_refs')
        .selectAll()
        .where('blob_id', '=', blobID)
        .orderBy('kind')
        .orderBy('key')
        .orderBy('blob_id')
        .execute()
      return rows.map(toRef)
    },
    async findRefs(params) {
      const { limit } = params
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid limit')
      let query = db.selectFrom('blob_refs').selectAll().where('kind', '=', params.kind)
      if (params.key !== undefined) query = query.where('key', '=', params.key)
      if (params.keyPrefix !== undefined)
        query = query
          .where('key', '>=', params.keyPrefix)
          .where('key', '<', `${params.keyPrefix}\x7f`)
      if (params.blobID !== undefined) query = query.where('blob_id', '=', params.blobID)
      if (params.cursor !== undefined) {
        let cursor: unknown
        try {
          cursor = JSON.parse(b64uToUTF(params.cursor))
        } catch {
          // Rejected below alongside malformed cursor shapes.
        }
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 3 ||
          !cursor.every((v) => typeof v === 'string')
        )
          throw new InvalidCursorError()
        const [kind, key, blobID] = cursor as [string, string, string]
        query = query.where((eb) =>
          eb.or([
            eb('kind', '>', kind),
            eb.and([eb('kind', '=', kind), eb('key', '>', key)]),
            eb.and([eb('kind', '=', kind), eb('key', '=', key), eb('blob_id', '>', blobID)]),
          ]),
        )
      }
      const rows = await query
        .orderBy('kind')
        .orderBy('key')
        .orderBy('blob_id')
        .limit(limit + 1)
        .execute()
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        refs: page.map(toRef),
        nextCursor:
          rows.length > limit && last !== undefined
            ? b64uFromUTF(JSON.stringify([last.kind, last.key, last.blob_id]))
            : null,
      }
    },
    upsertReleases: (ids, at) => withStoreTransaction(db, (trx) => upsertReleases(trx, ids, at)),
    async listReleases({ releasedBefore, limit = 100, blobID, forUpdate }) {
      assertBatchSize(limit, 500)
      if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid limit')
      let query = db
        .selectFrom('blob_releases')
        .selectAll()
        .where('released_at', '<', releasedBefore.getTime())
      if (blobID !== undefined) query = query.where('blob_id', '=', blobID)
      if (forUpdate && adapter.kind === 'postgres') query = query.forUpdate()
      const rows = await query.orderBy('released_at').orderBy('blob_id').limit(limit).execute()
      return rows.map((r) => ({ blobID: r.blob_id, releasedAt: r.released_at }))
    },
    async deleteRelease(blobID) {
      await db.deleteFrom('blob_releases').where('blob_id', '=', blobID).execute()
    },
  }
}
