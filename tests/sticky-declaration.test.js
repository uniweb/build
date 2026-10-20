/**
 * A section type's `sticky` — whether it stays in view unless its author says otherwise
 * (2026-10-19). The build refuses a malformed one, naming the component; the lean runtime schema
 * carries the rest (`runtime-schema.test.js`).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverComponents } from '../src/schema.js'

function foundationWith(meta) {
  const dir = mkdtempSync(join(tmpdir(), 'sticky-'))
  mkdirSync(join(dir, 'sections', 'Header'), { recursive: true })
  writeFileSync(join(dir, 'sections', 'Header', 'index.jsx'), 'export default () => null\n')
  writeFileSync(join(dir, 'sections', 'Header', 'meta.js'), `export default ${JSON.stringify(meta)}\n`)
  return dir
}

describe("a section type's sticky", () => {
  it('a malformed one stops the build, naming the component', async () => {
    const dir = foundationWith({ sticky: 'yes' })
    try {
      await expect(discoverComponents(dir)).rejects.toThrow(/Header \(meta\.js\): Invalid 'sticky'/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CONTROL — `{ default, top }` reaches the schema entry as written, for an editor', async () => {
    const dir = foundationWith({ sticky: { default: true, top: '4rem' } })
    try {
      const components = await discoverComponents(dir)
      expect(components.Header.sticky).toEqual({ default: true, top: '4rem' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
