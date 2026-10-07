# Kubun adopts hozon blob packages and table prefixes

Work happens in the kubun repo, under a separate spec. Hozon side is done; see
[the completed summary](../completed/2026-10-07-store-blob.complete.md).

- Switch kubun from `KubunDB` to `HozonDB({ tablePrefix: 'kubun' })`.
- Add a kubun-owned `blob-refs` store (`dependsOn: ['blob']`) providing `blob_refs`
  and `putRef`, `getRefsForDocument`, `getRefsForAttachment`, `removeRefsForDocument`.
- Move `BLOB_BYTE_ROUTE_PREFIX` into `plugin-blob`.
- Replace `attachmentID` with `blobID` at call sites of `@hozon/store-blob`.
- Delete kubun's `blob-backend`, `blob-node-fs`, and `store-blob` packages.
- Reset kubun databases (no data migration is provided).
