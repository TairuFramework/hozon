---
"@hozon/blob-id": minor
---

Breaking: blob IDs now start with the codec's multicodec code, so another hash can coexist under a new code. `blake3Codec` encodes `varint(0x1e) || varint(contentLength) || BLAKE3-256 digest` and `decode` rejects any other leading code. `BlobIDCodec` gains a required `code` field. IDs from earlier versions no longer decode.
