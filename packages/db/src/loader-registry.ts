import { type BatchLoader, type BatchLoaderParams, createBatchLoader } from './batch-loader.js'

export class LoaderRegistry {
  #remember: boolean
  #loaders = new Set<Pick<BatchLoader<unknown, unknown>, 'dispatch' | 'clearAll'>>()

  constructor(params: { remember: boolean }) {
    this.#remember = params.remember
  }

  createLoader<TKey, TValue>(params: BatchLoaderParams<TKey, TValue>): BatchLoader<TKey, TValue> {
    const loader = createBatchLoader({ ...params, remember: () => this.#remember })
    this.#loaders.add(loader)
    return loader
  }

  dispatchAll(): void {
    for (const loader of this.#loaders) loader.dispatch()
  }

  clearAll(): void {
    for (const loader of this.#loaders) loader.clearAll()
  }

  close(): void {
    this.#remember = false
    this.clearAll()
  }
}
