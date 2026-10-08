# Blob backends

`@hozon/blob-backend` exports `BlobBackend`, `BlobRange`, and `MemoryBlobBackend`.
Backends store bytes without inspecting content. Callers own hashing and content-addressed keys.
The contract uses Web Streams across Node, browser, and mobile runtimes.

```ts
type BlobRange = { start: number; end: number }
type BlobBackend = {
  createStaging(stagingID: string): Promise<WritableStream<Uint8Array>>
  writeChunk(stagingID: string, offset: number, bytes: Uint8Array): Promise<void>
  commit(stagingID: string, key: string): Promise<void>
  abortStaging(stagingID: string): Promise<void>
  createStagingReadStream(stagingID: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>
  listStaging?(): AsyncIterable<{ stagingID: string; modifiedAt: Date }>
  createReadStream(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  getURL(key: string): Promise<string | null>
}
```

`createStaging` accepts sequential writes. Close the writer before committing.
Reopening it resets existing staging bytes. `writeChunk` preserves other staged ranges for resumable downloads.
`writeChunk` creates staging when absent and writes at an absolute byte offset, supporting out-of-order chunks.
`commit` promotes staging to a key. An existing key remains unchanged, and its redundant staging is discarded.
Concurrent competing uploads preserve the first published bytes. Duplicate commits of the same staging area are idempotent.
`abortStaging` removes abandoned staging. `delete` removes committed bytes and tolerates absent keys.
`createStagingReadStream` reads uncommitted staged bytes, optionally a range, and rejects for an unknown staging ID.
`@hozon/blob` uses it to verify a transfer before commit. This method is required.
`listStaging` is optional. It yields live staging areas with their last write time, so abandoned areas can be pruned.
`commit` consumes the staging ID: a later `writeChunk` or `createStaging` with that ID starts an unrelated staging area.
`BlobRange` uses inclusive start and end offsets.

## MemoryBlobBackend

`new MemoryBlobBackend()` holds staging and committed bytes in memory without persistence.
It copies buffers on write and read, isolating stored bytes from caller mutations.
`getURL` always returns `null`.

## FSBlobBackend

`@hozon/blob-node-fs` exports `FSBlobBackend`. `new FSBlobBackend(root)` requires Node.js 24 or later.
Staging files live at `<root>/staging/<stagingID>`. Committed files live at `<root>/content/<key>`.
Commit atomically publishes a hard link without replacing existing content, then removes staging.
Staging and content must share a filesystem supporting hard links, including NTFS on Windows.
Sequential staging copies chunks before passing them to Node streams.
Positioned writes complete all bytes and reject zero progress.
`getURL` returns a file URL for existing content, or `null` when absent.
`has` returns `false` only for `ENOENT` and propagates other filesystem errors.
`listStaging` reports each staging file's modification time.

### File lock

`createFileBlobLock(directory, { acquireTimeoutMs? })` returns a `BlobLock` that excludes other processes on the same host, one lock file per canonical blob ID, built on `@sozai/lock`.
`directory` must be on a local filesystem. Its stale-lock reaping has a small documented exclusion gap.
Processes on different hosts need a distributed `BlobLock`; none ships.

Keys and staging IDs must be nonempty and differ from `.`.
They must contain none of `..`, `/`, `\`, `:`, or NUL.
Invalid names reject with `Invalid blob key: <JSON.stringify(value)>`.

Blob metadata, manifests, and transfer progress live in the [blob store](stores/blob.md).
