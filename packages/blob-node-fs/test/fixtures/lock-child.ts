import { join } from 'node:path'
import { withFileLock } from '@sozai/lock'

const [directory, id, holdMs] = process.argv.slice(2) as [string, string, string]

await withFileLock(join(directory, `${id}.lock`), async () => {
  console.log('locked')
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
})
