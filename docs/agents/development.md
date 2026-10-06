# Development

Use the `kigu:development` skill for the shared build, test, and development workflow.

## Repo-specific notes

PostgreSQL integration tests require Docker and use `HOZON_POSTGRES_URL`. The integration
harness is selected with `HOZON_INTEGRATION_BACKENDS` (`node-sqlite`, `postgres`, or a
comma-separated list; defaults to both).

Run `pnpm run test` for package type and unit tests. Run `pnpm run test:integration` for
integration tests. Driver conformance suites live in `packages/conformance/test/`.

## Package template

Package scripts follow `packages/env` in tejika:

```json
{
  "scripts": {
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "build:clean": "del-cli lib",
    "build:js": "del-cli \"lib/**/*.js\" && swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths",
    "build:types": "del-cli \"lib/**/*.d.ts\" \"lib/**/*.d.ts.map\" && tsc --emitDeclarationOnly --skipLibCheck",
    "build:types:ci": "tsc --emitDeclarationOnly --skipLibCheck --declarationMap false",
    "prepack": "pnpm run build:clean && pnpm run build:js && pnpm run build:types:ci",
    "test": "pnpm run test:types && pnpm run test:unit",
    "test:types": "tsc --noEmit --skipLibCheck -p tsconfig.test.json",
    "test:unit": "vitest run"
  },
  "devDependencies": {
    "del-cli": "catalog:",
    "vitest": "catalog:"
  }
}
```

Use the `tsconfig.json` and `tsconfig.test.json` shape from `packages/node` in kokuin.
Declare `del-cli` and `vitest` from the workspace catalog in every package's dev dependencies.
