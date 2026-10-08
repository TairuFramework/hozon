import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobBackend, BlobLock } from '@hozon/blob-backend'
import { createMemoryBlobLock, MemoryBlobBackend } from '@hozon/blob-backend'
import type { BlobIDCodec, BlobIDInfo } from '@hozon/blob-id'
import { blake3Codec, InvalidBlobIDError } from '@hozon/blob-id'
import { FSBlobBackend } from '@hozon/blob-node-fs'
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { BlobStoreAPI } from '@hozon/store-blob'
import { blobStoreDefinition, getBlobStore } from '@hozon/store-blob'

import type { BlobLimits, BlobService } from '../src/index.js'
import { createBlobService } from '../src/index.js'

export type BackendFactory = {
  name: string
  create(): Promise<{
    backend: BlobBackend
    cleanup(): Promise<void>
    // Sets the modification time of a staging area, for backends that use file times.
    touchStaging(stagingID: string, time: Date): Promise<void>
  }>
}

export const backendFactories: Array<BackendFactory> = [
  {
    name: 'MemoryBlobBackend',
    async create() {
      return {
        backend: new MemoryBlobBackend(),
        cleanup: async () => {},
        touchStaging: async () => {},
      }
    },
  },
  {
    name: 'FSBlobBackend',
    async create() {
      const root = await mkdtemp(join(tmpdir(), 'hozon-blob-service-'))
      return {
        backend: new FSBlobBackend(root),
        cleanup: () => rm(root, { recursive: true, force: true }),
        touchStaging: (stagingID, time) => utimes(join(root, 'staging', stagingID), time, time),
      }
    },
  },
]

export type TestService = {
  service: BlobService
  db: HozonDB
  store: BlobStoreAPI
  backend: BlobBackend
  lock: BlobLock
}

export async function createTestService(
  params: {
    backend?: BlobBackend
    codec?: BlobIDCodec
    chunkSize?: number
    lock?: BlobLock
    limits?: Partial<BlobLimits>
  } = {},
): Promise<TestService> {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  db.register(blobStoreDefinition)
  const backend = params.backend ?? new MemoryBlobBackend()
  const lock = params.lock ?? createMemoryBlobLock()
  const service = createBlobService({
    db,
    backend,
    codec: params.codec,
    chunkSize: params.chunkSize,
    lock,
    limits: params.limits,
  })
  return { service, db, store: await getBlobStore(db), backend, lock }
}

export function bytesOf(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + seed) % 256)
}

// Emits `bytes` in pieces of `pieceSize`, recording each pull.
export function sourceOf(
  bytes: Uint8Array,
  pieceSize = 3,
): { stream: ReadableStream<Uint8Array>; pulls: () => number } {
  let offset = 0
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + pieceSize))
      offset += pieceSize
    },
  })
  return { stream, pulls: () => pulls }
}

export function digestOf(bytes: Uint8Array): Uint8Array {
  const hasher = blake3Codec.createHasher()
  hasher.update(bytes)
  return hasher.digest()
}

export async function listStaging(backend: BlobBackend): Promise<Array<string>> {
  const ids: Array<string> = []
  for await (const area of backend.listStaging?.() ?? []) ids.push(area.stagingID)
  return ids
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
  return out
}

function base32Decode(text: string): Uint8Array {
  const out: Array<number> = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = BASE32.indexOf(char)
    if (value < 0) throw new Error(`Invalid base32 character ${char}`)
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

// Test codec embedding the content type: `<blake3 ID>-<base32(type)>`.
export const mimeCodec: BlobIDCodec = {
  digestLength: blake3Codec.digestLength,
  createHasher: () => blake3Codec.createHasher(),
  encode(info: BlobIDInfo): string {
    const base = blake3Codec.encode(info)
    return info.contentType === undefined
      ? base
      : `${base}-${base32Encode(new TextEncoder().encode(info.contentType))}`
  },
  decode(id: string): BlobIDInfo {
    const [base, type, ...rest] = id.split('-')
    if (base === undefined || rest.length > 0) throw new InvalidBlobIDError(id)
    const info = blake3Codec.decode(base)
    if (type === undefined) return info
    try {
      return { ...info, contentType: new TextDecoder().decode(base32Decode(type)) }
    } catch (cause) {
      throw new InvalidBlobIDError(id, { cause })
    }
  },
  canonicalize(id: string): string {
    const lower = id.toLowerCase()
    if (mimeCodec.encode(mimeCodec.decode(lower)) !== lower) throw new InvalidBlobIDError(id)
    return lower
  },
}
