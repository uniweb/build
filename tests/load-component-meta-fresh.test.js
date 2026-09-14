import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadComponentMeta } from '../src/schema.js'

/**
 * A dev server regenerates the foundation entry inside one long-lived process, so the
 * `meta.js` discovery reads has to be the file as it is now — not the module Node cached
 * the first time it was imported. The entry inlines that meta, and a section receives only
 * the `data:` keys it declares (2026-09-14): a key added in dev must reach the entry
 * without a restart.
 */
describe('loadComponentMeta reads meta.js as it is on disk', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uniweb-meta-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('an edited meta.js is read again in the same process', async () => {
    const file = join(dir, 'meta.js')
    writeFileSync(file, "export default { data: { team: '@/member' } }\n")
    expect((await loadComponentMeta(dir)).meta.data).toEqual({ team: '@/member' })

    writeFileSync(file, "export default { data: { team: '@/member', notes: {} } }\n")
    expect((await loadComponentMeta(dir)).meta.data).toEqual({ team: '@/member', notes: {} })
  })

  it('CONTROL — an unchanged meta.js is the module already loaded, not a new copy', async () => {
    writeFileSync(join(dir, 'meta.js'), "export default { data: { team: '@/member' } }\n")
    const first = (await loadComponentMeta(dir)).meta
    const second = (await loadComponentMeta(dir)).meta
    expect(second).toBe(first)
  })
})
