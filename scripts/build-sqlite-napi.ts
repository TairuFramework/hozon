import { spawnSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const release = process.argv.includes('--release')
const copyOnly = process.argv.includes('--copy-only')
const targetDir = resolve(process.env.CARGO_TARGET_DIR ?? 'target')
if (!copyOnly) {
  const result = spawnSync(
    'cargo',
    [
      'build',
      '--manifest-path',
      resolve(repoRoot, 'Cargo.toml'),
      '-p',
      'hozon-sqlite-napi',
      ...(release ? ['--release'] : []),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cargo build failed (${result.status})`)
}
const filename =
  process.platform === 'win32'
    ? 'hozon_sqlite_napi.dll'
    : `libhozon_sqlite_napi.${process.platform === 'darwin' ? 'dylib' : 'so'}`
const source = resolve(targetDir, release ? 'release' : 'debug', filename)
const destination = resolve(repoRoot, 'packages/native/native/hozon-sqlite-napi.node')
await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)
console.log(`Copied ${source} to ${destination}`)
