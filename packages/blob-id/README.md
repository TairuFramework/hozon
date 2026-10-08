# @hozon/blob-id

Pluggable content-addressed blob IDs for Hozon. Portable: no Node APIs.

```sh
pnpm add @hozon/blob-id
```

## Codec contract

A `BlobIDCodec` turns a content digest and length into an opaque ID string and back:

- `digestLength`: digest size in bytes.
- `createHasher()`: returns `{ update(bytes), digest() }` for incremental hashing.
- `encode(info)`: `{ digest, contentLength, contentType? }` to ID.
- `decode(id)`: ID to `{ digest, contentLength }`; throws `InvalidBlobIDError` for malformed IDs.
- `canonicalize(id)`: returns the canonical form of an ID (for example lowercased); throws `InvalidBlobIDError` if invalid.

IDs must only use `[a-z0-9_-]` (`BLOB_ID_ALPHABET`) and must not contain `..`, so they are safe as path segments.

## Default format

`blake3Codec`: `varint(contentLength) || BLAKE3-256 digest`, encoded as lowercase RFC 4648 base32 without padding. `contentType` is not part of the ID.

Known answer for the empty blob (`contentLength` 0, digest `af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262`):
the ID is the base32 of byte `0x00` followed by that digest.

```ts
import { blake3Codec } from '@hozon/blob-id'

const hasher = blake3Codec.createHasher()
hasher.update(bytes)
const id = blake3Codec.encode({ digest: hasher.digest(), contentLength: bytes.length })
```

## Hashing a stream

`hashStream(codec, chunkSize)` returns a pass-through `TransformStream` and a `result` promise resolving to `{ digest, contentLength, chunks }`, where `chunks` holds one digest per `chunkSize` chunk (the last may be shorter). `result` rejects if the stream errors or is cancelled.

## Conformance

Custom codecs can be checked with `checkCodecConformance`, which throws an `Error` describing the first violation:

```ts
import { checkCodecConformance } from '@hozon/blob-id/conformance'

checkCodecConformance(myCodec, [{ digest, contentLength: 0 }, { digest, contentLength: 42 }])
```
