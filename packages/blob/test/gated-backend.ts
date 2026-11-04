import type { BlobBackend } from '@hozon/blob-backend'
import { MemoryBlobBackend } from '@hozon/blob-backend'

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export function gatedBackend(memory: BlobBackend = new MemoryBlobBackend()) {
  const gates = new Map<
    string,
    { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }
  >()
  async function wait(method: string) {
    const gate = gates.get(method)
    if (gate === undefined) return
    gates.delete(method)
    gate.entered.resolve()
    await gate.release.promise
  }
  const backend: BlobBackend = {
    createStaging: (id) => memory.createStaging(id),
    abortStaging: (id) => memory.abortStaging(id),
    createReadStream: (id, range) => memory.createReadStream(id, range),
    has: (id) => memory.has(id),
    getURL: (id) => memory.getURL(id),
    listStaging: () => memory.listStaging?.() ?? emptyStaging(),
    async commit(id, key) {
      await wait('commit')
      await memory.commit(id, key)
    },
    async delete(id) {
      await wait('delete')
      await memory.delete(id)
    },
    async writeChunk(id, offset, bytes) {
      await wait('writeChunk')
      await memory.writeChunk(id, offset, bytes)
    },
    async createStagingReadStream(id, range) {
      await wait('createStagingReadStream')
      return await memory.createStagingReadStream(id, range)
    },
  }
  return {
    backend,
    park(method: 'commit' | 'delete' | 'writeChunk' | 'createStagingReadStream') {
      const gate = { entered: deferred(), release: deferred() }
      gates.set(method, gate)
      return {
        entered: gate.entered.promise,
        release: () => gate.release.resolve(),
        fail: (error: Error) => gate.release.reject(error),
      }
    },
  }
}

async function* emptyStaging(): AsyncIterable<{ stagingID: string; modifiedAt: Date }> {}
