/**
 * The keys of a section's frontmatter that are not params — `SECTION_KEYS` in
 * `@uniweb/schemas/section` — are exactly what the collector keeps out of a section's params,
 * so the one list the build's warning and the docs read is the one the build obeys.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECTION_KEYS } from '@uniweb/schemas/section'
import { processMarkdownFile } from '../src/site/content-collector.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'section-keys-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const collect = async (frontmatter) => {
  writeFileSync(join(dir, 'hero.md'), `---\n${frontmatter}\n---\n\n# Hi\n`)
  return (await processMarkdownFile(join(dir, 'hero.md'), '0', dir)).section
}

describe('a section’s params', () => {
  it('hold none of SECTION_KEYS, and props only by its keys', async () => {
    const section = await collect(
      'type: Hero\nid: intro\nhidden: false\nquery: team\nprops: { columns: 3 }\npreset: glass\ninput: x\nlayout: center'
    )
    expect(section.params).toEqual({ layout: 'center', columns: 3 })
    for (const key of Object.keys(SECTION_KEYS)) expect(section.params, key).not.toHaveProperty(key)
  })

  it('CONTROL — any other key is a param, declared or not', async () => {
    const section = await collect('type: Hero\nlayout: center\nvariant: glass')
    expect(section.params).toEqual({ layout: 'center', variant: 'glass' })
  })

  it('and fetch, a setting of the section, is kept on the section rather than in its params', async () => {
    const section = await collect('type: Hero\nfetch: { query: team }\nlayout: center')
    expect(section.params).toEqual({ layout: 'center' })
    expect(section.fetch).toBeTruthy()
  })
})
