# @hozon/blob-node-fs

Node filesystem blob backend with staged uploads, atomic commits, and inclusive byte range reads.

```sh
pnpm add @hozon/blob-node-fs
```

```ts
import { FSBlobBackend } from '@hozon/blob-node-fs'

const backend = new FSBlobBackend('/var/lib/app/blobs')
const writer = (await backend.createStaging('upload-1')).getWriter()
await writer.write(new Uint8Array([1, 2, 3]))
await writer.close()
await backend.commit('upload-1', 'abc')
const stream = await backend.createReadStream('abc')
```

Requires Node.js 24 or later. Staging files live under `<root>/staging`, and committed files under `<root>/content/<key>`.
Keys and staging IDs must be nonempty, differ from `.`, and contain no `..`, `/`, `\`, `:`, or NUL bytes.
Invalid names reject with `Invalid blob key: <JSON.stringify(value)>`.
`getURL` returns a file URL for existing content, or `null` when absent.
`has` returns `false` only for `ENOENT` and propagates other filesystem errors.
Sequential staging copies chunks before passing them to Node streams.
Reopening `createStaging` truncates previous bytes. Positioned `writeChunk` calls preserve other ranges and complete all bytes, rejecting zero progress.
`commit` atomically publishes a hard link without replacing existing content, then removes staging.
Concurrent competing uploads preserve the first published bytes. Duplicate commits of the same staging area are idempotent.
Staging and content directories must share a filesystem that supports hard links, including NTFS on Windows.

See the [blob backend reference](../../docs/reference/blob-backends.md#fsblobbackend).
