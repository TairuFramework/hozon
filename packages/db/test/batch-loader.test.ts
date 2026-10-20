import { afterEach, describe, expect, test, vi } from 'vitest'

import { createBatchLoader, trackedGenerationCount } from '../src/batch-loader.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(options: { maxBatchSize?: number; remember?: boolean } = {}) {
  const calls: Array<Array<string>> = []
  const state = { remember: options.remember ?? false }
  const load = vi.fn(async (keys: Array<string>) => {
    calls.push(keys)
    return new Map<string, string | null>(keys.map((key) => [key, `v-${key}`]))
  })
  const loader = createBatchLoader<string, string>({
    load,
    maxBatchSize: options.maxBatchSize ?? 100,
    remember: () => state.remember,
  })
  return { loader, load, calls, state }
}

describe('createBatchLoader', () => {
  test('does not track key generations when nothing is in flight', async () => {
    const { loader, state } = setup({ remember: true })
    for (let i = 0; i < 100; i++) loader.clear(`k${i}`)
    expect(trackedGenerationCount(loader)).toBe(0)

    state.remember = true
    const pending = loader.load('a')
    loader.dispatch()
    loader.clear('a')
    expect(trackedGenerationCount(loader)).toBe(1)
    await pending
    expect(trackedGenerationCount(loader)).toBe(0)
  })

  test('merges same-tick loads into one call', async () => {
    const { loader, calls } = setup()
    const values = await Promise.all(['a', 'b', 'c'].map((id) => loader.load(id)))
    expect(values).toEqual(['v-a', 'v-b', 'v-c'])
    expect(calls).toEqual([['a', 'b', 'c']])
  })

  test('dedupes a key requested twice in one tick', async () => {
    const { loader, calls } = setup()
    const [first, second] = await Promise.all([loader.load('a'), loader.load('a')])
    expect(first).toBe('v-a')
    expect(second).toBe('v-a')
    expect(calls).toEqual([['a']])
  })

  test('collects loads made after one prior await in the same tick', async () => {
    const { loader, calls } = setup()
    const values = await Promise.all(
      ['a', 'b', 'c'].map(async (id) => {
        await Promise.resolve()
        return loader.load(id)
      }),
    )
    expect(values).toEqual(['v-a', 'v-b', 'v-c'])
    expect(calls).toHaveLength(1)
  })

  test('splits a batch above maxBatchSize', async () => {
    const { loader, calls } = setup({ maxBatchSize: 2 })
    const ids = ['a', 'b', 'c', 'd', 'e']
    const values = await Promise.all(ids.map((id) => loader.load(id)))
    expect(values).toEqual(ids.map((id) => `v-${id}`))
    expect(calls).toHaveLength(3)
    for (const keys of calls) expect(keys.length).toBeLessThanOrEqual(2)
  })

  test('resolves null for a key missing from the result map', async () => {
    const loader = createBatchLoader<string, string>({
      load: async () => new Map([['a', 'v-a']]),
      maxBatchSize: 10,
      remember: () => false,
    })
    const [a, b] = await Promise.all([loader.load('a'), loader.load('b')])
    expect(a).toBe('v-a')
    expect(b).toBeNull()
  })

  test('does not remember when remember() is false', async () => {
    const { loader, load } = setup({ remember: false })
    await loader.load('a')
    await loader.load('a')
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('remembers when remember() is true until clear', async () => {
    const { loader, load } = setup({ remember: true })
    await loader.load('a')
    await loader.load('a')
    expect(load).toHaveBeenCalledTimes(1)
    loader.clear('a')
    await loader.load('a')
    expect(load).toHaveBeenCalledTimes(2)
    await loader.load('a')
    expect(load).toHaveBeenCalledTimes(2)
    loader.clearAll()
    await loader.load('a')
    expect(load).toHaveBeenCalledTimes(3)
  })

  test('a new load after dispatch does not join the in-flight batch', async () => {
    const { loader, load } = setup()
    const first = loader.load('a')
    loader.dispatch()
    const second = loader.load('a')
    await Promise.all([first, second])
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('a late superseded result is not remembered', async () => {
    const pending: Array<Deferred<Map<string, string | null>>> = []
    const load = vi.fn((_keys: Array<string>) => {
      const d = deferred<Map<string, string | null>>()
      pending.push(d)
      return d.promise
    })
    const loader = createBatchLoader<string, string>({
      load,
      maxBatchSize: 10,
      remember: () => true,
    })
    const a = loader.load('x')
    loader.dispatch()
    loader.clear('x')
    const b = loader.load('x')
    loader.dispatch()
    expect(load).toHaveBeenCalledTimes(2)

    pending[1]?.resolve(new Map([['x', 'new']]))
    expect(await b).toBe('new')
    pending[0]?.resolve(new Map([['x', 'old']]))
    expect(await a).toBe('old')

    expect(await loader.load('x')).toBe('new')
    expect(load).toHaveBeenCalledTimes(2)
  })

  describe('failure', () => {
    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled)
      unhandled.length = 0
    })

    test('a failed batch rejects every caller and is not remembered', async () => {
      process.on('unhandledRejection', onUnhandled)
      const error = new Error('boom')
      let fail = true
      const load = vi.fn(async (keys: Array<string>) => {
        if (fail) throw error
        return new Map<string, string | null>(keys.map((key) => [key, `v-${key}`]))
      })
      const loader = createBatchLoader<string, string>({
        load,
        maxBatchSize: 10,
        remember: () => true,
      })

      const results = await Promise.allSettled([loader.load('a'), loader.load('b')])
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
      for (const r of results) expect((r as PromiseRejectedResult).reason).toBe(error)

      fail = false
      expect(await loader.load('a')).toBe('v-a')
      expect(load).toHaveBeenCalledTimes(2)

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    })
  })
})
