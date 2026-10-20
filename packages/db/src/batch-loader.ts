import { type Deferred, defer } from '@sozai/async'

import { chunk } from './keep-set.js'

export type BatchLoaderParams<TKey, TValue> = {
  load: (keys: Array<TKey>) => Promise<Map<TKey, TValue | null>>
  maxBatchSize: number
}

export type BatchLoader<TKey, TValue> = {
  load(key: TKey): Promise<TValue | null>
  clear(key: TKey): void
  clearAll(): void
  dispatch(): void
}

// Runs after the microtask queue drains, so loads chained behind a few awaits still coalesce.
function scheduleAfterMicrotasks(fn: () => void): void {
  if (typeof setImmediate === 'function') setImmediate(fn)
  else setTimeout(fn, 0)
}

/**
 * Coalesces same-tick `load` calls into batched `params.load` calls of at most `maxBatchSize`
 * keys. `remember` is read at settle time so a scope can switch the loader to batch-only.
 */
export function createBatchLoader<TKey, TValue>(
  params: BatchLoaderParams<TKey, TValue> & { remember: () => boolean },
): BatchLoader<TKey, TValue> {
  const { load, maxBatchSize, remember } = params
  let pending = new Map<TKey, Deferred<TValue | null>>()
  let scheduled = false
  const remembered = new Map<TKey, TValue | null>()
  // Both counters only grow, so their sum changes whenever either is bumped.
  const keyGenerations = new Map<TKey, number>()
  let globalGeneration = 0
  // Per-key bumps only matter to in-flight chunks; dropping them when idle bounds the map.
  let inFlight = 0

  const generationOf = (key: TKey): number => globalGeneration + (keyGenerations.get(key) ?? 0)

  async function dispatchChunk(entries: Array<[TKey, Deferred<TValue | null>]>): Promise<void> {
    const generations = entries.map(([key]) => generationOf(key))
    inFlight++
    try {
      const results = await load(entries.map(([key]) => key))
      const shouldRemember = remember()
      entries.forEach(([key, deferred], index) => {
        const value = results.get(key) ?? null
        if (shouldRemember && generationOf(key) === generations[index]) {
          remembered.set(key, value)
        }
        deferred.resolve(value)
      })
    } catch (error) {
      for (const [, deferred] of entries) deferred.reject(error)
    } finally {
      inFlight--
      if (inFlight === 0) keyGenerations.clear()
    }
  }

  function dispatch(): void {
    if (pending.size === 0) return
    const entries = [...pending]
    pending = new Map()
    for (const part of chunk(entries, maxBatchSize)) void dispatchChunk(part)
  }

  const loader: BatchLoader<TKey, TValue> = {
    load(key) {
      if (remember() && remembered.has(key)) {
        return Promise.resolve(remembered.get(key) as TValue | null)
      }
      const existing = pending.get(key)
      if (existing != null) return existing.promise
      const deferred = defer<TValue | null>()
      pending.set(key, deferred)
      if (!scheduled) {
        scheduled = true
        scheduleAfterMicrotasks(() => {
          scheduled = false
          dispatch()
        })
      }
      return deferred.promise
    },
    clear(key) {
      if (inFlight > 0) keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1)
      remembered.delete(key)
    },
    clearAll() {
      globalGeneration++
      remembered.clear()
    },
    dispatch,
  }
  generationProbes.set(loader, () => keyGenerations.size)
  return loader
}

const generationProbes = new WeakMap<object, () => number>()

/** Test probe: number of per-key generation entries a loader currently tracks. */
export function trackedGenerationCount(loader: object): number {
  return generationProbes.get(loader)?.() ?? 0
}
