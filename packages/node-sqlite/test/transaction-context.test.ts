import { expect, test } from 'vitest'

import { NodeSQLiteAdapter } from '../src/index.js'

test('provides async context isolated from unrelated tasks', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  try {
    const context = adapter.transactionContext
    expect(context).toBeDefined()
    expect(context.active()).toBe(false)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const running = context.run(async () => {
      started.resolve()
      await release.promise
      expect(context.active()).toBe(true)
      return 'done'
    })
    await started.promise
    expect(context.active()).toBe(false)
    release.resolve()
    await expect(running).resolves.toBe('done')
    expect(context.active()).toBe(false)
  } finally {
    await adapter.close()
  }
})

test.each([false, true])(
  'inherited context is inactive after settlement (rollback: %s)',
  async (rollback) => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    const context = adapter.transactionContext
    const release = Promise.withResolvers<void>()
    let inherited: Promise<boolean> | undefined
    try {
      const running = context.run(async () => {
        inherited = release.promise.then(() => context.active())
        if (rollback) throw new Error('rollback')
      })
      if (rollback) await expect(running).rejects.toThrow('rollback')
      else await running
      release.resolve()
      await expect(inherited).resolves.toBe(false)
    } finally {
      release.resolve()
      await adapter.close()
    }
  },
)
