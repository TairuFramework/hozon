'use strict'

const path = require('node:path')

// Kysely's `kysely/migration` entry (imported by @hozon/db for its Migrator) re-exports
// FileMigrationProvider, whose dynamic import() of a variable path Hermes cannot compile.
// Redirect that module to an empty one. https://github.com/kysely-org/kysely/issues/1628
const EMPTY_MODULE = path.join(__dirname, 'empty.cjs')
const FILE_MIGRATION_PROVIDER = /(^|\/)file-migration-provider(\.js)?$/
const KYSELY_SEGMENT = `${path.sep}kysely${path.sep}`

/**
 * Wraps a Metro config so @hozon packages bundle for Hermes. Chains any existing
 * `resolver.resolveRequest` and returns the same config.
 */
function withHozonMetroConfig(config) {
  config.resolver = config.resolver ?? {}
  const previous = config.resolver.resolveRequest
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (
      context.originModulePath.includes(KYSELY_SEGMENT) &&
      FILE_MIGRATION_PROVIDER.test(moduleName)
    ) {
      return { type: 'sourceFile', filePath: EMPTY_MODULE }
    }
    return previous
      ? previous(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform)
  }
  return config
}

module.exports = { withHozonMetroConfig }
