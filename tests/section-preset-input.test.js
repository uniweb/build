/**
 * `preset:` and `input:` in a section's frontmatter have no effect, so they are dropped
 * with a warning — neither reaches the component, the render payload or the sync wire,
 * and a pull does not write a stored one back [2026-09-27]. A preset is a named set of
 * params a section type's `meta.js` offers an editor; a file writes the params.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processMarkdownFile } from '../src/site/content-collector.js'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

let dir
let warnings
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'section-preset-'))
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

const site = {
  'site.yml': "name: S\nfoundation: '@a/base@1.0.0'\n",
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/hero.md': '---\ntype: Hero\npreset: glass\ninput: x\nlayout: center\n---\n\n# Hi\n',
}

describe('the collector', () => {
  it('drops preset and input with a warning, and passes neither to the component', async () => {
    write(dir, { 'hero.md': site['pages/home/hero.md'] })
    const { section } = await processMarkdownFile(join(dir, 'hero.md'), '0', dir)
    expect(section.params).toEqual({ layout: 'center' })
    expect(section).not.toHaveProperty('preset')
    expect(section).not.toHaveProperty('input')
    expect(warnings.join('\n')).toMatch(/preset: "glass" has no effect.*write the preset’s params/)
    expect(warnings.join('\n')).toMatch(/input: "x" has no effect/)
  })

  it('says nothing about a section that carries neither', async () => {
    write(dir, { 'hero.md': '---\ntype: Hero\nlayout: center\n---\n' })
    await processMarkdownFile(join(dir, 'hero.md'), '0', dir)
    expect(warnings).toEqual([])
  })
})

describe('the sync wire', () => {
  it('carries neither field', async () => {
    write(dir, site)
    const section = (await siteProjectToDocument(dir)).pages[0].page_sections[0]
    expect(section).not.toHaveProperty('preset')
    expect(section).not.toHaveProperty('input')
    expect(section.params).toEqual({ layout: 'center' })
  })

  it('a pull does not write a stored preset or input back into the file', async () => {
    write(dir, site)
    const doc = await siteProjectToDocument(dir)
    Object.assign(doc.pages[0].page_sections[0], { preset: 'glass', input: 'x' })
    const dest = mkdtempSync(join(tmpdir(), 'section-preset-pulled-'))
    try {
      siteContentDocumentToProject({ document: doc, siteRoot: dest })
      const file = readFileSync(join(dest, 'pages/home/hero.md'), 'utf8')
      expect(file).not.toMatch(/preset:|input:/)
      expect(file).toMatch(/layout: center/)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
