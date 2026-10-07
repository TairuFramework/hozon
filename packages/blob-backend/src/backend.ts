// A BlobBackend stages uploads, promotes them to a content-addressed key,
// and serves bytes back. The store owns hashing and the key format.
// The backend never inspects content. Web Streams keep it portable across
// Node.js, browsers, and mobile runtimes.

export type BlobRange = {
  // Inclusive byte offsets.
  start: number
  end: number
}

export type BlobBackend = {
  // Open a writable sink for an in-progress upload. The caller pumps bytes in
  // order and closes the stream, then calls `commit`.
  createStaging(stagingID: string): Promise<WritableStream<Uint8Array>>
  // Write bytes at an absolute offset into a staging area, creating it if
  // absent. For resumable range downloads: chunks may arrive out of order, so
  // the caller places each at `index * chunkSize`. Then `commit` promotes it.
  writeChunk(stagingID: string, offset: number, bytes: Uint8Array): Promise<void>
  // Promote fully-staged bytes to the content-addressed key. Idempotent: a
  // no-op if `key` already exists (content-addressed, so bytes are identical).
  commit(stagingID: string, key: string): Promise<void>
  // Discard an abandoned staging area.
  abortStaging(stagingID: string): Promise<void>
  // Read committed bytes, optionally a byte range.
  createReadStream(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  // A locator for the committed bytes (e.g. a `file://` path), or null when the
  // backend cannot produce one. Served/presigned URLs are a later concern.
  getURL(key: string): Promise<string | null>
}
