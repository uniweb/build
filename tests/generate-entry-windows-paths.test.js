import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Discovery builds a section's path with `path.join`, so on Windows it holds backslashes. Written
// into the generated entry as they were, `./sections\Abstract/index.jsx` read as
// `./sectionsAbstract/index.jsx`, and no foundation with a section could build there.
vi.mock('../src/schema.js', async (importOriginal) => ({
  ...(await importOriginal()),
  discoverComponents: async () => ({
    Abstract: { name: 'Abstract', path: 'sections\\Abstract', entryFile: 'index.jsx' },
    Nested: { name: 'Nested', path: 'sections\\group\\Nested', entryFile: 'index.jsx' },
  }),
  discoverLayoutsInPath: async () => ({
    Main: { name: 'Main', path: 'layouts\\Main', entryFile: 'index.jsx' },
  }),
}))

const { generateEntryPoint } = await import('../src/generate-entry.js')

describe('the generated entry, from the paths Windows discovers', () => {
  let dir

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('imports each section and layout by a path with forward slashes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uniweb-entry-'))
    const out = join(dir, '_entry.generated.js')
    await generateEntryPoint(dir, out)
    const source = readFileSync(out, 'utf8')
    expect(source).toContain(`import Abstract from './sections/Abstract/index.jsx'`)
    expect(source).toContain(`import Nested from './sections/group/Nested/index.jsx'`)
    expect(source).toContain(`import Main from './layouts/Main/index.jsx'`)
    expect(source).not.toMatch(/from '[^']*\\/)
  })
})
