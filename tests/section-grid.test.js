/**
 * `grid:` — a name framework reserves for the layout of a section's child sections
 * [Diego, 2026-09-27]: `3` (equal columns) or `'40/60'` (relative widths).
 *
 * It stays in the section's params, like `background` — that is where every key the
 * author writes is stored and synced, so it needs no field of its own on any wire.
 * `@uniweb/core` lifts it to `block.grid` and hides it from the component's params;
 * kit's `ChildGrid` lays the children out. ⛔ For a few hours on 2026-09-27 the build
 * took it out of the params into a field the sync wire then had to withhold.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processMarkdownFile } from '../src/site/content-collector.js'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
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

const write = (root, files) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

describe('the collector', () => {
  it('keeps grid in the params, where it is stored and synced', async () => {
    write(dir, { 'grid.md': "---\ntype: Grid\ngrid: '40/60'\ngap: lg\n---\n\n# Items\n" })
    const { section } = await processMarkdownFile(join(dir, 'grid.md'), '0', dir)
    expect(section.params).toEqual({ grid: '40/60', gap: 'lg' })
    expect(section).not.toHaveProperty('grid')
    expect(warnings).toEqual([])
  })

  it('warns on a value that is not a layout, and keeps it for the author to fix', async () => {
    write(dir, { 'grid.md': "---\ntype: Grid\ngrid: '40/'\n---\n" })
    const { section } = await processMarkdownFile(join(dir, 'grid.md'), '0', dir)
    expect(section.params.grid).toBe('40/')
    expect(warnings.join('\n')).toMatch(/grid: "40\/" is not a layout/)
  })
})

describe('the sync wire', () => {
  const site = {
    'site.yml': "name: S\nfoundation: '@a/base@1.0.0'\n",
    'pages/home/page.yml': 'title: Home\n',
    'pages/home/grid.md': "---\ntype: Grid\ngrid: '40/60'\n---\n\n# Items\n",
  }

  it('carries grid inside the params — nothing a store has to declare', async () => {
    write(dir, site)
    const doc = await siteProjectToDocument(dir)
    const section = doc.pages[0].page_sections[0]
    expect(section.params).toEqual({ grid: '40/60' })
    expect(section).not.toHaveProperty('grid')
    expect(warnings).toEqual([])
  })

  it('round-trips: a pull writes it back to the frontmatter', async () => {
    write(dir, site)
    const doc = await siteProjectToDocument(dir)
    const dest = mkdtempSync(join(tmpdir(), 'section-grid-pulled-'))
    try {
      siteContentDocumentToProject({ document: doc, siteRoot: dest })
      expect(readFileSync(join(dest, 'pages/home/grid.md'), 'utf8')).toMatch(/grid: ['"]?40\/60/)
      expect(await siteProjectToDocument(dest)).toEqual(doc)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})

describe('a component param named grid', () => {
  it('is warned about — grid: is the section’s setting, never passed to the component', () => {
    reportPlacementDeclarations({ Grid: { name: 'Grid', params: { grid: { type: 'number' } } } })
    expect(warnings.join('\n')).toMatch(/Grid.*params declares "grid", a setting of the section/)
    expect(warnings.join('\n')).toMatch(/children: \{ grid: \[\.\.\.\] \}/)
  })

  // The same for theme and background — ⛔ worded until 2026-09-28 as if the section lost the
  // author's value; the section keeps it, and framework applies it.
  it('and theme or background the same way: the section applies it, so the declaration goes', () => {
    reportPlacementDeclarations({ CTA: { name: 'CTA', params: { theme: { type: 'select', options: ['light', 'dark'] } } } })
    expect(warnings.join('\n')).toMatch(/CTA.*params declares "theme", a setting of the section.*framework applies an author's theme: to the section.*Remove it from params:/)
    expect(warnings.join('\n')).not.toMatch(/Rename the param/)
  })
})
