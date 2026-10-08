# hozon documentation

- [TairuFramework stack overview](https://github.com/TairuFramework/kigu/blob/main/docs/stack.md)
- [Architecture](agents/architecture.md)
- [Development](agents/development.md)

## Reference

- [Adapter contract](reference/adapter.md)
- [Database lifecycle](reference/db.md)
- [Drivers](reference/drivers.md)
- [Stores](reference/stores.md)
- [Blob backends](reference/blob-backends.md)
- [Telemetry integrations](reference/telemetry.md)

## Blob packages

- [@hozon/blob-id](../packages/blob-id/README.md) -- content-addressed blob IDs and hashing
- [@hozon/blob](../packages/blob/README.md) -- verified blob service over a backend and the blob store
- [@hozon/blob-backend](../packages/blob-backend/README.md) -- byte storage contract and in-memory backend
- [@hozon/blob-node-fs](../packages/blob-node-fs/README.md) -- Node filesystem backend
- [@hozon/store-blob](../packages/store-blob/README.md) -- metadata, manifests, and resumable transfers

The [blob store reference](reference/stores/blob.md) documents blob APIs and transfer lifecycle; the [blob backend reference](reference/blob-backends.md) documents backend key rules.
