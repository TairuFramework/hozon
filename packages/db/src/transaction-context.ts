import type { AsyncLocalStorage } from 'node:async_hooks'

type TransactionContext = { active: boolean }
type ContextConstructor = new <T>() => AsyncLocalStorage<T>
type Runtime = {
  AsyncLocalStorage?: ContextConstructor
  process?: { getBuiltinModule?: (name: string) => unknown }
  Bun?: unknown
  Deno?: unknown
}

const runtime = globalThis as Runtime
let contextConstructor: Promise<ContextConstructor | undefined> | undefined

export async function createTransactionContext(): Promise<
  AsyncLocalStorage<TransactionContext> | undefined
> {
  contextConstructor ??= loadConstructor()
  const Constructor = await contextConstructor
  return Constructor == null ? undefined : new Constructor<TransactionContext>()
}

async function loadConstructor(): Promise<ContextConstructor | undefined> {
  let Constructor = runtime.AsyncLocalStorage
  if (Constructor == null) {
    const builtin = runtime.process?.getBuiltinModule?.('node:async_hooks') as
      | { AsyncLocalStorage?: ContextConstructor }
      | undefined
    Constructor = builtin?.AsyncLocalStorage
  }
  if (Constructor == null && (runtime.Bun != null || runtime.Deno != null)) {
    // Metro rejects even guarded nonliteral imports. Only server runtimes reach this loader.
    const loadBuiltin = new Function('return import("node:async_hooks")') as () => Promise<{
      AsyncLocalStorage?: ContextConstructor
    }>
    try {
      Constructor = (await loadBuiltin()).AsyncLocalStorage
    } catch {
      // Older server runtimes may not provide async context.
    }
  }
  return Constructor
}
