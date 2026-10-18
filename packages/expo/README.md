# @hozon/expo

Expo SQLite (`expo-sqlite`) adapter for Hozon on iOS and Android.

```sh
pnpm add @hozon/expo @hozon/db expo-sqlite
```

```ts
import { HozonDB } from '@hozon/db'
import { ExpoAdapter } from '@hozon/expo'

const db = new HozonDB({ adapter: new ExpoAdapter({ database: 'hozon.db' }) })
```

## Encryption at rest

Pass a raw 32-byte `encryptionKey` to encrypt the database file with SQLCipher. Enable SQLCipher
in the `expo-sqlite` config plugin first:

```json
{ "expo": { "plugins": [["expo-sqlite", { "useSQLCipher": true }]] } }
```

```ts
const adapter = new ExpoAdapter({ database: 'hozon.db', encryptionKey })
```

The adapter throws if SQLCipher is not linked, so the file is never left in plaintext by mistake,
and throws `file is not a database` when the key does not match. Keep the key outside the
database, for example in `expo-secure-store`. An existing plaintext database is not encrypted in
place.

## Metro setup

Kysely's migration entry re-exports `FileMigrationProvider`, which Hermes cannot compile
([kysely#1628](https://github.com/kysely-org/kysely/issues/1628)). Wrap your Metro config
with `withHozonMetroConfig` so the module is replaced by an empty one:

```js
// metro.config.js
const { withHozonMetroConfig } = require('@hozon/expo/metro')
const { getDefaultConfig } = require('expo/metro-config')

module.exports = withHozonMetroConfig(getDefaultConfig(__dirname))
```

Any existing `config.resolver.resolveRequest` is kept and called for every other request.

See the [driver reference](../../docs/reference/drivers.md) for serialization and platform details.
