const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// Kysely's barrel export includes FileMigrationProvider, whose dynamic import() of a
// variable path Hermes cannot compile. Redirect it to an empty shim (as kubun's app does).
// GitHub issue: https://github.com/kysely-org/kysely/issues/1628
const EMPTY_MODULE = path.resolve(__dirname, 'shims/empty.js')

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    context.originModulePath.includes(`${path.sep}kysely${path.sep}`) &&
    /(^|\/)file-migration-provider(\.js)?$/.test(moduleName)
  ) {
    return { type: 'sourceFile', filePath: EMPTY_MODULE }
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
