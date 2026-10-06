import { join, sep } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import {
  type MetroResolutionContext,
  type MetroResolveRequest,
  withHozonMetroConfig,
} from '../metro/index.cjs'

const KYSELY_ORIGIN = join(sep, 'app', 'node_modules', 'kysely', 'dist', 'migration', 'index.js')
const APP_ORIGIN = join(sep, 'app', 'App.tsx')

function createContext(originModulePath: string) {
  const resolveRequest = vi.fn<MetroResolveRequest>(() => ({
    type: 'sourceFile',
    filePath: 'resolved.js',
  }))
  const context: MetroResolutionContext = { originModulePath, resolveRequest }
  return { context, resolveRequest }
}

describe('withHozonMetroConfig', () => {
  test('redirects kysely file-migration-provider to an empty module', () => {
    const config = withHozonMetroConfig({ resolver: {} })
    const { context, resolveRequest } = createContext(KYSELY_ORIGIN)
    const result = config.resolver.resolveRequest(
      context,
      './file-migration-provider.js',
      'ios',
    ) as { type: string; filePath: string }
    expect(result.type).toBe('sourceFile')
    expect(result.filePath.endsWith(join('expo', 'metro', 'empty.cjs'))).toBe(true)
    expect(resolveRequest).not.toHaveBeenCalled()
  })

  test('passes other requests through to the default resolver', () => {
    const config = withHozonMetroConfig({ resolver: {} })
    const kysely = createContext(KYSELY_ORIGIN)
    config.resolver.resolveRequest(kysely.context, './migrator.js', 'ios')
    expect(kysely.resolveRequest).toHaveBeenCalledWith(kysely.context, './migrator.js', 'ios')

    const app = createContext(APP_ORIGIN)
    config.resolver.resolveRequest(app.context, './file-migration-provider.js', 'android')
    expect(app.resolveRequest).toHaveBeenCalledWith(
      app.context,
      './file-migration-provider.js',
      'android',
    )
  })

  test('chains an existing custom resolveRequest', () => {
    const custom = vi.fn<MetroResolveRequest>(() => ({ type: 'empty' }))
    const config = withHozonMetroConfig({ resolver: { resolveRequest: custom } })
    const { context, resolveRequest } = createContext(APP_ORIGIN)
    expect(config.resolver.resolveRequest(context, 'react', 'ios')).toEqual({ type: 'empty' })
    expect(custom).toHaveBeenCalledWith(context, 'react', 'ios')
    expect(resolveRequest).not.toHaveBeenCalled()

    const kysely = createContext(KYSELY_ORIGIN)
    config.resolver.resolveRequest(kysely.context, './file-migration-provider.js', 'ios')
    expect(custom).toHaveBeenCalledTimes(1)
  })

  test('returns the same config object', () => {
    const input = { resolver: {}, projectRoot: '/app' }
    expect(withHozonMetroConfig(input)).toBe(input)
  })
})
