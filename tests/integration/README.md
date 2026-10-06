# integration-tests

Hozon integration tests against real node:sqlite files and a real Postgres server.

```sh
pnpm run test:integration                      # from the repo root; Docker running
HOZON_INTEGRATION_BACKENDS=node-sqlite pnpm run test:integration   # no Postgres
```

Postgres comes from `HOZON_POSTGRES_URL` when set, otherwise from a testcontainers
`postgres:18-alpine`. Without either, Postgres tests are skipped with a notice locally and
fail when `CI=true`. For repeated local runs, start the bundled server once:

```sh
docker compose up -d --wait
HOZON_POSTGRES_URL=postgres://postgres:hozon@localhost:5432/postgres pnpm run test:integration
```
