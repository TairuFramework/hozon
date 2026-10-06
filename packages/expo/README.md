# @hozon/expo

Expo SQLite (`expo-sqlite`) adapter for Hozon on iOS and Android.

```ts
import { HozonDB } from '@hozon/db'
import { ExpoAdapter } from '@hozon/expo'

const db = new HozonDB({ adapter: new ExpoAdapter({ database: 'hozon.db' }) })
```

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
