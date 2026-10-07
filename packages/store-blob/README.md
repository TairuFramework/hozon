# @hozon/store-blob

Content-addressed blob metadata, persistent chunk manifests, and resumable transfer progress.
Byte storage and digest verification belong to the caller.

```sh
pnpm add @hozon/store-blob @hozon/db
```

```ts
import { blobStoreDefinition, getBlobStore } from '@hozon/store-blob'

db.register(blobStoreDefinition)
const blobs = await getBlobStore(db)
await blobs.insertEntry(
  {
    blobID: 'content-key',
    contentLength: 0,
    chunkSize: 4,
    state: 'local',
    createdAt: Date.now(),
  },
  [],
)
```

Entries map integer flags to booleans and expose camelCase fields.
Encryption and key IDs are optional metadata that the store does not interpret.
Repeated entry and manifest inserts preserve existing rows.

For a known remote entry, `beginTransfer` records its manifest and sets its state to `partial`.
Record each verified chunk with `recordTransferChunk`, then call `finalizeTransfer` when all chunks are present.
Finalisation preserves the manifest, clears transfer progress, and sets the entry state to `local`.
`beginTransfer` and `finalizeTransfer` reject absent entries with `Blob entry <blobID> not found`.
Finalisation rejects missing chunks with `Cannot finalize transfer <blobID>: <count> chunk(s) missing`.
`deleteEntry` removes the entry, manifest, and transfer progress together.

Tables follow the database's configured prefix, which defaults to `hozon`.
Multi-statement mutations are atomic and reuse a provider transaction.
Manifest inserts use batches of 166 rows to stay below 500 bound parameters.

See the [store reference](../../docs/reference/stores.md).
