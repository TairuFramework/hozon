import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HozonDB } from '@hozon/db'
import { getLogStore, type LogStore, logStoreDefinition } from '@hozon/store-log'
import { afterEach, describe, expect, test } from 'vitest'

import { backendsNamed } from '../src/backends.js'
import { sampleLog } from '../src/helpers.js'

const WRITER = fileURLToPath(new URL('./fixtures/writer.ts', import.meta.url))

function runWriter(path: string, count: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', WRITER, path, String(count)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

async function countLogs(store: LogStore): Promise<number> {
  let total = 0
  let cursor: string | undefined
  do {
    const page = await store.queryLogs({ limit: 1000, cursor })
    total += page.logs.length
    cursor = page.cursor
  } while (cursor !== undefined)
  return total
}

describe.each(backendsNamed('node-sqlite'))('$name', (backend) => {
  afterEach(() => backend.cleanup())

  test('two processes write the same file without SQLITE_BUSY', async () => {
    // Migrate up front, so the children contend on writes rather than on schema creation.
    const setup = new HozonDB({ adapter: await backend.createAdapter() })
    setup.register(logStoreDefinition)
    await setup.migrate()
    await setup.close()

    const results = await Promise.all([
      runWriter(backend.location(), 500),
      runWriter(backend.location(), 500),
    ])
    expect(results).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ])

    const db = new HozonDB({ adapter: await backend.reopen() })
    db.register(logStoreDefinition)
    try {
      expect(await countLogs(await getLogStore(db))).toBe(1000)
    } finally {
      await db.close()
    }
  })
})

describe.each(backendsNamed('postgres'))('$name', (backend) => {
  afterEach(() => backend.cleanup())

  test('20 concurrent transactions with savepoints succeed', async () => {
    const db = new HozonDB({ adapter: await backend.createAdapter() })
    db.register(logStoreDefinition)
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          db.withTransaction(async (tx) => {
            const store = await getLogStore(tx)
            await store.addLogs([sampleLog(index, `outer ${index}`)])
            await tx.withSavepoint?.(async (savepoint) => {
              await (await getLogStore(savepoint)).addLogs([sampleLog(index, `kept ${index}`)])
            })
            await expect(
              tx.withSavepoint?.(async (savepoint) => {
                await (await getLogStore(savepoint)).addLogs([
                  sampleLog(index, `discarded ${index}`),
                ])
                throw new Error('roll back savepoint')
              }),
            ).rejects.toThrow('roll back savepoint')
          }),
        ),
      )
      const { logs } = await (await getLogStore(db)).queryLogs({ limit: 1000 })
      expect(logs).toHaveLength(40)
      expect(logs.filter((log) => log.message.startsWith('discarded'))).toEqual([])
    } finally {
      await db.close()
    }
  })
})
