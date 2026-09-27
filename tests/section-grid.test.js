/**
 * `grid:` — a section key framework reserves for the layout of the section's child
 * sections [Diego, 2026-09-27]: `3` (equal columns) or `'40/60'` (relative widths).
 *
 * The build carries it on the section, never among the params; kit's `ChildGrid` lays
 * the children out from `block.grid`. The sync wire does not send it until backend
 * declares the field — a store refuses a whole push carrying a key it has not declared.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processMarkdownFile } from '../src/site/content-collector.js'
import { siteProjectToDocument } from '../src/uwx/index.js'
import { reportPlacementDeclarations } from '../src/schema.js'

let dir
let warnings
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'section-grid-'))
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const write = (files) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
}

describe('the collector', () => {
  it('carries grid on the section, never among the params', async () => {
    write({ 'grid.md': "---\ntype: Grid\ngrid: '40/60'\ngap: lg\n---\n\n# Items\n" })
    const { section } = await processMarkdownFile(join(dir, 'grid.md'), '0', dir)
    expect(section.grid).toBe('40/60')
    expect(section.params).toEqual({ gap: 'lg' })
    expect(warnings).toEqual([])
  })

  it('a count reads as a count', async () => {
    write({ 'grid.md': '---\ntype: Grid\ngrid: 3\n---\n' })
    const { section } = await processMarkdownFile(join(dir, 'grid.md'), '0', dir)
    expect(section.grid).toBe(3)
  })

  it('warns on a value that is not a layout, and keeps it for the author to fix', async () => {
    write({ 'grid.md': "---\ntype: Grid\ngrid: '40/'\n---\n" })
    const { section } = await processMarkdownFile(join(dir, 'grid.md'), '0', dir)
    expect(section.grid).toBe('40/')
    expect(warnings.join('\n')).toMatch(/grid: "40\/" is not a layout/)
  })

  it('a section with no grid has none', async () => {
    write({ 'hero.md': '---\ntype: Hero\n---\n' })
    const { section } = await processMarkdownFile(join(dir, 'hero.md'), '0', dir)
    expect(section).not.toHaveProperty('grid')
  })
})

describe('the sync wire', () => {
  it('does not send grid yet — and says so, rather than dropping it silently', async () => {
    write({
      'site.yml': "name: S\nfoundation: '@a/base@1.0.0'\n",
      'pages/home/page.yml': 'title: Home\n',
      'pages/home/grid.md': "---\ntype: Grid\ngrid: '40/60'\n---\n\n# Items\n",
    })
    const doc = await siteProjectToDocument(dir)
    const section = doc.pages[0].page_sections[0]
    expect(section).not.toHaveProperty('grid')
    expect(section.params ?? {}).not.toHaveProperty('grid')
    expect(warnings.join('\n')).toMatch(/grid: "40\/60" is not sent/)
  })
})

describe('a component param named grid', () => {
  it('is warned about — it never receives the author’s grid:', () => {
    reportPlacementDeclarations({ Grid: { name: 'Grid', params: { grid: { type: 'number' } } } })
    expect(warnings.join('\n')).toMatch(/Grid.*param named "grid"/)
  })
})
