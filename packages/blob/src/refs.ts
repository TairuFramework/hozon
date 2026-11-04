import { assertBatchSize } from '@hozon/db'
import type { BlobEntry, BlobHolderSelector, BlobRefInput, FindRefsParams } from '@hozon/store-blob'
import { getBlobStore } from '@hozon/store-blob'

import { lockBlobs, retryTransaction } from './locking.js'
import type { ManageContext } from './manage.js'

function validateKind(kind: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) throw new Error('Invalid holder kind')
}
function validateKey(key: string): void {
  if (!/^[\x20-\x7e]{1,512}$/.test(key)) throw new Error('Invalid holder key')
}
function canonicalRefs(ctx: ManageContext, refs: Array<BlobRefInput>): Array<BlobRefInput> {
  return refs.map((ref) => {
    validateKind(ref.kind)
    validateKey(ref.key)
    return { ...ref, blobID: ctx.codec.canonicalize(ref.blobID) }
  })
}

export async function addRefs(
  ctx: ManageContext,
  input: Array<BlobRefInput>,
): Promise<Map<string, BlobEntry | null>> {
  assertBatchSize(input.length, 500)
  const refs = canonicalRefs(ctx, input)
  const ids = [...new Set(refs.map((ref) => ref.blobID))]
  if (ids.length === 0) return new Map()
  return await lockBlobs(ctx.db, ids, async (tx) => {
    const store = await getBlobStore(tx)
    await store.insertRefs(refs)
    return await store.getEntries(ids)
  })
}

export async function removeRefs(ctx: ManageContext, refs: Array<BlobRefInput>): Promise<number> {
  const canonical = canonicalRefs(ctx, refs)
  return await retryTransaction(ctx.db, () =>
    ctx.db.withTransaction(async (tx) => {
      return (await (await getBlobStore(tx)).deleteRefs(canonical)).length
    }),
  )
}

export async function removeHolders(
  ctx: ManageContext,
  selector: BlobHolderSelector,
): Promise<number> {
  validateKind(selector.kind)
  validateKey('key' in selector ? selector.key : selector.keyPrefix)
  return await retryTransaction(ctx.db, () =>
    ctx.db.withTransaction(async (tx) => {
      return (await (await getBlobStore(tx)).deleteRefsByHolder(selector)).length
    }),
  )
}

export async function listRefs(ctx: ManageContext, id: string) {
  return await (await getBlobStore(ctx.db)).listRefs(ctx.codec.canonicalize(id))
}

export async function findRefs(ctx: ManageContext, params: FindRefsParams) {
  validateKind(params.kind)
  if (params.key !== undefined) validateKey(params.key)
  if (params.keyPrefix !== undefined) validateKey(params.keyPrefix)
  if (params.key !== undefined && params.keyPrefix !== undefined)
    throw new Error('Choose key or keyPrefix')
  return await (await getBlobStore(ctx.db)).findRefs({
    ...params,
    ...(params.blobID === undefined ? {} : { blobID: ctx.codec.canonicalize(params.blobID) }),
  })
}
