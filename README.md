# hozon

Database adapters, stores, and telemetry integrations for the TairuFramework stack.

| Package | Purpose |
| --- | --- |
| `@hozon/adapter` | Shared database adapter contract |
| `@hozon/db` | Database lifecycle, migrations, and transactions |
| `@hozon/node-sqlite` | Node SQLite driver |
| `@hozon/postgres` | PostgreSQL driver |
| `@hozon/expo` | Expo SQLite driver |
| `@hozon/sqlocal` | Browser SQLite driver |
| `@hozon/provider` | Node database driver selection |
| `@hozon/conformance` | Shared driver conformance suite |
| `@hozon/store-log` | Persistent log store |
| `@hozon/store-telemetry` | Persistent telemetry store |
| `@hozon/logtape` | LogTape integration |
| `@hozon/otel` | OpenTelemetry integration |

See [the documentation](docs/index.md) for architecture and development guidance.

- [Architecture](docs/agents/architecture.md)
- [Development](docs/agents/development.md)
- [API reference](docs/index.md#reference)
