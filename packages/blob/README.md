# @hozon/blob

Content-addressed blob service: verified writes over a `BlobBackend` with metadata in `@hozon/store-blob`.
Portable: no Node.js APIs.

```sh
pnpm add @hozon/blob @hozon/blob-backend @hozon/store-blob @hozon/db
```

```ts
import { MemoryBlobBackend } from '@hozon/blob-backend'
import { createBlobService } from '@hozon/blob'
import { blobStoreDefinition } from '@hozon/store-blob'

// Registering the store definition is the caller's job.
db.register(blobStoreDefinition)
const blobs = createBlobService({ db, backend: new MemoryBlobBackend() })

const { entry, created } = await blobs.write(stream, { contentType: 'image/png' })
```

Options: `codec` (default `blake3Codec`), `chunkSize` (default 1 MiB), `lock` (default `createMemoryBlobLock()`), and `limits` (`maxBlobSize` 1 GiB, `maxChunkSize` 16 MiB, `minChunkSize` 1 KiB).
`createBlobService` throws `Invalid chunkSize` when `chunkSize` is outside the chunk limits, and `Invalid limits` for invalid limits.

## Write

`write(stream, { contentType?, encrypted?, keyID?, expectedID?, maxSize?, signal? })` returns `{ entry, created }`.

1. `expectedID` is canonicalized and decoded before the body is read. A content type embedded in the ID fills an omitted `contentType`; a different one throws `ContentTypeMismatchError`. A decoded length above the limit throws `BlobTooLargeError`.
2. The body streams into a fresh staging area while hashing. Crossing `min(maxSize, limits.maxBlobSize)` throws `BlobTooLargeError`. A stream error aborts staging and rethrows it.
3. A computed ID different from `expectedID` throws `BlobIDMismatchError`.
4. Under the blob lock: an already-local blob keeps its metadata (a null `contentType` is filled from this write) and returns `created: false`. Otherwise bytes are committed, then the entry and manifest are recorded, replacing any `remote-only` or `partial` state and discarding that transfer's staging area.

Bytes are committed before the row, so a failure leaves only orphan bytes, never a row without bytes.
Aborting `signal` stops reading, discards staging, and throws `BlobWriteAbortedError`; the signal is checked again before commit.

`writeWith(stream, options, fn)` records the entry and calls `fn(tx, entry)` in one store transaction, returning `{ entry, created, result }`.
It takes the blob lock before the transaction; the caller must not already be inside a store transaction (single-connection SQLite would deadlock).
If `fn` throws, the transaction rolls back and the committed bytes remain as orphans.

## Errors

`BlobNotFoundError`, `BlobTooLargeError`, `BlobIDMismatchError`, `ContentTypeMismatchError`, `ChunkDigestMismatchError`, `ChunkLengthError`, `InvalidManifestError`, `InvalidRangeError`, `BlobWriteAbortedError`, and the re-exported `InvalidBlobIDError` and `BlobLockTimeoutError`.
