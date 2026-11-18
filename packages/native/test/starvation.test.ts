import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execute = promisify(execFile)

test.each([1, 4])('queued admissions cannot exhaust libuv with %i worker(s)', async (poolSize) => {
  // A child gives this regression a deterministic pool size, independent of Vitest.
  const binding = fileURLToPath(new URL('../native/hozon-sqlite-napi.node', import.meta.url))
  const { stdout } = await execute(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `
    const sqlite = require(process.argv[1]);
    (async () => {
      const db = await sqlite.open(':memory:', { readers: 4, busyTimeoutMs: 5000, journalMode: 'wal' });
      const holder = await sqlite.beginWrite(db);
      const waiters = Array.from({ length: 16 }, () => sqlite.beginWrite(db, { timeoutMs: 500 }).catch(() => null));
      await new Promise(resolve => setTimeout(resolve, 50));
      const start = performance.now();
      await sqlite.execute(db, holder.txID, 'SELECT 1', [], 'read');
      await sqlite.commit(db, holder.txID);
      const elapsedMs = performance.now() - start;
      for (const waiter of waiters) {
        const admission = await waiter;
        if (admission) await sqlite.abandon(db, admission.admissionID);
      }
      await sqlite.close(db);
      console.log(JSON.stringify({ elapsedMs }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
      binding,
    ],
    { env: { ...process.env, UV_THREADPOOL_SIZE: String(poolSize) }, timeout: 3000 },
  )
  const result = JSON.parse(stdout) as { elapsedMs: number }
  expect(result.elapsedMs).toBeLessThan(150)
})
