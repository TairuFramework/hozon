import type { NativePendingAdmission as AdapterPendingAdmission } from '@hozon/adapter'
import { expectTypeOf, it } from 'vitest'

import type { NativePendingAdmission, NativeSQLite } from '../src/index.js'

it('exports the pending admission contract from both package entry points', () => {
  expectTypeOf<NativePendingAdmission>().toEqualTypeOf<AdapterPendingAdmission>()
  expectTypeOf<ReturnType<NativeSQLite['beginWrite']>>().toEqualTypeOf<NativePendingAdmission>()
})
