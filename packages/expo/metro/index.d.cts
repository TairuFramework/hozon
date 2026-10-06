export type MetroResolutionContext = {
  originModulePath: string
  resolveRequest: MetroResolveRequest
}

export type MetroResolveRequest = (
  context: MetroResolutionContext,
  moduleName: string,
  platform: string | null,
) => unknown

export type MetroConfigLike = {
  resolver?: { resolveRequest?: MetroResolveRequest | null; [key: string]: unknown }
  [key: string]: unknown
}

/**
 * Wraps a Metro config so @hozon packages bundle for Hermes. Chains any existing
 * `resolver.resolveRequest` and returns the same config.
 */
export function withHozonMetroConfig<T extends MetroConfigLike>(
  config: T,
): T & { resolver: { resolveRequest: MetroResolveRequest } }
