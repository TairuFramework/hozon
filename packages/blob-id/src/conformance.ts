import { InvalidBlobIDError } from './errors.js'
import { BLOB_ID_ALPHABET, type BlobIDCodec, type BlobIDInfo } from './types.js'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/** Throw an `Error` describing the first contract violation of `codec` over `samples`. */
export function checkCodecConformance(codec: BlobIDCodec, samples: Array<BlobIDInfo>): void {
  for (const [index, sample] of samples.entries()) {
    const label = `sample ${index}`
    const id = codec.encode(sample)
    if (!BLOB_ID_ALPHABET.test(id)) {
      throw new Error(`${label}: ID ${JSON.stringify(id)} does not match ${BLOB_ID_ALPHABET}`)
    }
    if (id.includes('..')) {
      throw new Error(`${label}: ID ${JSON.stringify(id)} contains ".."`)
    }
    const canonical = codec.canonicalize(id)
    if (canonical !== id) {
      throw new Error(
        `${label}: canonicalize(${JSON.stringify(id)}) returned ${JSON.stringify(canonical)}`,
      )
    }
    try {
      const upper = codec.canonicalize(id.toUpperCase())
      if (upper !== id) {
        throw new Error(
          `${label}: canonicalize of uppercase ID returned ${JSON.stringify(upper)}, expected ${JSON.stringify(id)}`,
        )
      }
    } catch (error) {
      if (!(error instanceof InvalidBlobIDError)) {
        throw error
      }
    }
    const decoded = codec.decode(id)
    if (decoded.contentLength !== sample.contentLength) {
      throw new Error(
        `${label}: decode changed contentLength ${sample.contentLength} to ${decoded.contentLength}`,
      )
    }
    if (!bytesEqual(decoded.digest, sample.digest)) {
      throw new Error(`${label}: decode changed digest`)
    }
  }
}
