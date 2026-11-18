import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

test('binary copy resolves the shared target independently of cwd and honours its override', async () => {
  const original = fileURLToPath(new URL('../../../scripts/build-sqlite-napi.ts', import.meta.url))
  const worktreeTarget = fileURLToPath(new URL('../../../../../target/', import.meta.url))
  const fixture = await mkdtemp(resolve(worktreeTarget, 'napi-copy-'))
  try {
    const scripts = resolve(fixture, 'stack/hozon/scripts')
    await mkdir(scripts, { recursive: true })
    const script = resolve(scripts, 'build-sqlite-napi.ts')
    await copyFile(original, script)
    const env = { ...process.env }
    delete env.CARGO_TARGET_DIR
    const filename =
      process.platform === 'win32'
        ? 'hozon_sqlite_napi.dll'
        : `libhozon_sqlite_napi.${process.platform === 'darwin' ? 'dylib' : 'so'}`
    for (const configured of [undefined, resolve(fixture, 'custom-target')]) {
      const target = configured ?? resolve(fixture, 'target')
      await mkdir(resolve(target, 'debug'), { recursive: true })
      await writeFile(resolve(target, 'debug', filename), target)
      const result = spawnSync(process.execPath, [script, '--copy-only'], {
        cwd: fixture,
        env: configured === undefined ? env : { ...env, CARGO_TARGET_DIR: configured },
        encoding: 'utf8',
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(resolve(target, 'debug'))
      expect(
        await readFile(
          resolve(fixture, 'stack/hozon/packages/native/native/hozon-sqlite-napi.node'),
          'utf8',
        ),
      ).toBe(target)
    }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
