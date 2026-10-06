# hozon

> Conventions: `kigu:conventions` skill (canonical -- do not restate).
> Stack map / sibling docs: `kigu:stack-map` skill.

## What this repo is

hozon provides database adapters, stores, and telemetry integrations for the TairuFramework stack.

## Guardrails

Use pnpm only. Never call `.transaction()` inside store methods; use `withStoreTransaction`.
No statement may bind more than 500 parameters.
