import { AsyncLocalStorage } from 'node:async_hooks'
import type { TransactionContext } from '@hozon/adapter'

export function createTransactionContext(): TransactionContext {
  const context = new AsyncLocalStorage<{ active: boolean }>()
  return {
    active: () => context.getStore()?.active === true,
    async run(fn) {
      const state = { active: true }
      return await context.run(state, async () => {
        try {
          return await fn()
        } finally {
          // Async tasks can inherit this state and outlive the callback.
          state.active = false
        }
      })
    },
  }
}
