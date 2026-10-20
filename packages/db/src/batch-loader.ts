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

type Deferred<TValue> = {
  promise: Promise<TValue | null>
  resolve: (value: TValue | null) => void
  reject: (error: unknown) => void
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: (value: TValue | null) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<TValue | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
  let pending = new Map<TKey, Deferred<TValue>>()
  let scheduled = false
  const remembered = new Map<TKey, TValue | null>()
  // Both counters only grow, so their sum changes whenever either is bumped.
  const keyGenerations = new Map<TKey, number>()
  let globalGeneration = 0

  const generationOf = (key: TKey): number => globalGeneration + (keyGenerations.get(key) ?? 0)

  async function dispatchChunk(entries: Array<[TKey, Deferred<TValue>]>): Promise<void> {
    const generations = entries.map(([key]) => generationOf(key))
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
    }
  }

  function dispatch(): void {
    if (pending.size === 0) return
    const entries = [...pending]
    pending = new Map()
    for (const part of chunk(entries, maxBatchSize)) void dispatchChunk(part)
  }

  return {
    load(key) {
      if (remember() && remembered.has(key)) {
        return Promise.resolve(remembered.get(key) as TValue | null)
      }
      const existing = pending.get(key)
      if (existing != null) return existing.promise
      const deferred = createDeferred<TValue>()
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
      keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1)
      remembered.delete(key)
    },
    clearAll() {
      globalGeneration++
      remembered.clear()
    },
    dispatch,
  }
}
