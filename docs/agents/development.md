# Development

Use the `kigu:development` skill for the shared build, test, and development workflow.
Use `kigu:conventions` for code and documentation conventions.

## Repo-specific notes

Run `pnpm run test` for package type and unit tests. Run `pnpm run test:integration` for integration tests. Set `HOZON_POSTGRES_URL` to use an existing PostgreSQL server. Set `HOZON_INTEGRATION_BACKENDS` to select `node-sqlite`, `postgres`, or both.

Driver conformance suites live in `packages/conformance/test/`. Chromium and Firefox web end-to-end tests block CI. The WebKit job is best-effort because WebKit 26.6 on macOS lacks OPFS storage support.

See [architecture](architecture.md) and the [reference index](../index.md).
