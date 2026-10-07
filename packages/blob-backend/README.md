# @hozon/blob-backend

Byte storage interface and in-memory backend for Hozon blobs.
The store owns hashing and the key format. The backend stores bytes without inspecting content.

```sh
pnpm add @hozon/blob-backend
```

```ts
import { MemoryBlobBackend } from '@hozon/blob-backend'

const backend = new MemoryBlobBackend()
const writer = (await backend.createStaging('upload-1')).getWriter()
await writer.write(new Uint8Array([1, 2, 3]))
await writer.close()
await backend.commit('upload-1', 'blob-key')
const stream = await backend.createReadStream('blob-key', { start: 0, end: 1 })
```

Implement `BlobBackend` for other byte storage systems. `BlobRange` uses inclusive byte offsets.
`writeChunk` stages bytes by offset, including chunks received out of order.
`commit` preserves an existing key and discards the staging area. `abortStaging` discards abandoned uploads.

`MemoryBlobBackend` keeps bytes in memory without persistence. Its `getURL` method always returns `null`.
It copies buffers on write and read, isolating stored bytes from caller mutations.

See the [store reference](../../docs/reference/stores.md#blob-backends).
