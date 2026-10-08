---
name: discover
description: Use when exploring hozon capabilities or choosing which hozon domain guidance to load.
---

# Hozon discovery

Hozon provides database adapters, stores, and telemetry integrations for the TairuFramework stack.

## Domains

Load the domain skill matching your task:

- `/hozon:database` -- HozonDB, store definitions, migrations, and transactions
- `/hozon:drivers` -- choosing and configuring a database driver across platforms
- `/hozon:telemetry` -- log and span stores, LogTape sink, OTel exporter, and retention

## Blob packages

- `@hozon/blob-id` -- content-addressed blob ID codec and hashing
- `@hozon/blob` -- verified blob service: writes, reads, resumable peer transfer, staging pruning
- `@hozon/blob-backend` -- `BlobBackend`, inclusive `BlobRange`, and `MemoryBlobBackend`
- `@hozon/blob-node-fs` -- `FSBlobBackend` for Node filesystem byte storage
- `@hozon/store-blob` -- metadata, chunk manifests, and resumable transfer progress

Load `/hozon:database` for blob store registration, migrations, and table prefixes.
Read `../../../../docs/reference/stores/blob.md` for blob APIs and transfer lifecycle, and `../../../../docs/reference/blob-backends.md` for backends and filesystem key rules.

For an overview of the driver contract, start with `../../../../docs/reference/adapter.md`.

## Conventions

This repo follows the shared stack conventions -- see the `kigu:conventions` skill.
Repo-specific guardrails are in the root `AGENTS.md`.
