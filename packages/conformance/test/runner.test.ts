import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import * as assert from '../src/assert.js'
import { runConformance, summarize } from '../src/index.js'

const createAdapter = async () => new NodeSQLiteAdapter({ database: ':memory:' })

test('failure is reported without stopping later cases; every adapter is closed before cleanup', async () => {
  const adapters: Array<NodeSQLiteAdapter> = []
  const events: Array<string> = []
  const results = await runConformance({
    createAdapter: async () => {
      const adapter = await createAdapter()
      adapters.push(adapter)
      return adapter
    },
    cleanup: async () => {
      expect(adapters.at(-1)?.database.isOpen).toBe(false)
      events.push('cleanup')
    },
    cases: [
      {
        name: 'fails',
        run: async () => {
          throw new Error('expected failure')
        },
      },
      {
        name: 'passes',
        run: async () => {
          events.push('later')
        },
      },
    ],
  })
  expect(results).toEqual([
    { name: 'fails', ok: false, error: 'expected failure' },
    { name: 'passes', ok: true },
  ])
  expect(events).toEqual(['cleanup', 'later', 'cleanup'])
  expect(adapters[0]).not.toBe(adapters[1])
})

test('factory and cleanup failures are reported and do not stop later cases', async () => {
  let attempts = 0
  let cleanups = 0
  const results = await runConformance({
    createAdapter: async () => {
      if (++attempts === 1) throw new Error('factory failed')
      return createAdapter()
    },
    cleanup: async () => {
      if (++cleanups === 2) throw new Error('cleanup failed')
    },
    cases: ['factory', 'cleanup', 'later'].map((name) => ({ name, run: async () => {} })),
  })
  expect(results).toEqual([
    { name: 'factory', ok: false, error: 'factory failed' },
    { name: 'cleanup', ok: false, error: 'cleanup failed' },
    { name: 'later', ok: true },
  ])
  expect(cleanups).toBe(3)
})

test('db factory uses the case adapter and runner closes a database after a failing case', async () => {
  let adapter: NodeSQLiteAdapter | undefined
  const results = await runConformance({
    createAdapter: async () => {
      adapter = await createAdapter()
      return adapter
    },
    cases: [
      {
        name: 'db',
        run: async (ctx) => {
          const db = ctx.db({ tablePrefix: 'custom' })
          expect(db.adapter).toBe(ctx.adapter)
          await db.migrate()
          throw 'non-Error failure'
        },
      },
    ],
  })
  expect(results).toEqual([{ name: 'db', ok: false, error: 'non-Error failure' }])
  expect(adapter?.database.isOpen).toBe(false)
})

test('summaries use the exact platform output format and count passed cases', () => {
  const pass = summarize([
    { name: 'a', ok: true },
    { name: 'b', ok: true },
  ])
  expect({ ok: pass.ok, passed: pass.passed, total: pass.total }).toEqual({
    ok: true,
    passed: 2,
    total: 2,
  })
  expect(pass.line('Conformance')).toBe('Conformance: OK 2/2')
  const fail = summarize([
    { name: 'a', ok: true },
    { name: 'b', ok: false },
  ])
  expect(fail.ok).toBe(false)
  expect(fail.line('Conformance')).toBe('Conformance: FAIL 1/2')
  expect(summarize([]).line('Conformance')).toBe('Conformance: OK 0/0')
})

test('portable assertions detect unequal values and incorrect rejections', async () => {
  assert.equal(0.1 + 0.2, 0.1 + 0.2)
  assert.ok(true)
  assert.deepEqual(
    { b: [1, { x: '雪' }], a: new Uint8Array([0, 255]) },
    { a: new Uint8Array([0, 255]), b: [1, { x: '雪' }] },
  )
  expect(() => assert.equal(1, 2)).toThrow()
  expect(() => assert.ok(false)).toThrow()
  expect(() => assert.deepEqual({ a: undefined }, {})).toThrow()
  expect(() => assert.deepEqual(new Uint8Array([1]), new Uint8Array([2]))).toThrow()
  expect(() => assert.deepEqual(new Date(0), new Date(1))).toThrow()
  await assert.rejects(async () => {
    throw new TypeError('expected message')
  }, TypeError)
  await assert.rejects(async () => {
    throw new Error('expected message')
  }, 'expected message')
  await expect(assert.rejects(async () => {}, Error)).rejects.toThrow()
  await expect(
    assert.rejects(async () => {
      throw new Error('wrong')
    }, TypeError),
  ).rejects.toThrow()
  await expect(
    assert.rejects(async () => {
      throw new Error('wrong')
    }, 'expected'),
  ).rejects.toThrow()
})

test('deep equality distinguishes sparse arrays of different lengths', () => {
  expect(() => assert.deepEqual(new Array(1), [])).toThrow()
})
