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

For an overview of the driver contract, start with `../../../../docs/reference/adapter.md`.

## Conventions

This repo follows the shared stack conventions -- see the `kigu:conventions` skill.
Repo-specific guardrails are in the root `AGENTS.md`.
