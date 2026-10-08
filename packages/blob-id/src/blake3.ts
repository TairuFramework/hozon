import { blake3 } from '@noble/hashes/blake3.js'

import { base32Decode, base32Encode } from './base32.js'
import { InvalidBlobIDError } from './errors.js'
import type { BlobHasher, BlobIDCodec, BlobIDInfo } from './types.js'
import { decodeVarint, encodeVarint } from './varint.js'

const DIGEST_LENGTH = 32

function encode(info: BlobIDInfo): string {
  if (info.digest.length !== DIGEST_LENGTH) {
    throw new RangeError(`Expected a ${DIGEST_LENGTH}-byte digest, got ${info.digest.length}`)
  }
  const prefix = encodeVarint(info.contentLength)
  const bytes = new Uint8Array(prefix.length + DIGEST_LENGTH)
  bytes.set(prefix, 0)
  bytes.set(info.digest, prefix.length)
  return base32Encode(bytes)
}

function decode(id: string): BlobIDInfo {
  try {
    const bytes = base32Decode(id)
    const { value, length } = decodeVarint(bytes)
    if (bytes.length !== length + DIGEST_LENGTH) {
      throw new RangeError('Unexpected ID length')
    }
    return { digest: bytes.slice(length), contentLength: value }
  } catch (cause) {
    throw new InvalidBlobIDError(id, { cause })
  }
}

function canonicalize(id: string): string {
  const lower = id.toLowerCase()
  if (encode(decode(lower)) !== lower) {
    throw new InvalidBlobIDError(id)
  }
  return lower
}

/** Default codec: `varint(contentLength) || BLAKE3-256 digest`, lowercase base32. */
export const blake3Codec: BlobIDCodec = {
  digestLength: DIGEST_LENGTH,
  createHasher(): BlobHasher {
    const hasher = blake3.create({})
    return {
      update: (bytes) => {
        hasher.update(bytes)
      },
      digest: () => hasher.digest(),
    }
  },
  encode,
  decode,
  canonicalize,
}
