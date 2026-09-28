/**
 * `hidden:` in a section's frontmatter — a draft section, the page's meaning one level
 * down [Diego, 2026-09-28]: left out of a published build with its child sections, kept
 * by `uniweb dev` so it stays previewable, synced as the section's own `hidden`, and
 * written back by a pull. ⛔ Until then it was an ordinary param: the component received
 * it and the section rendered everywhere, and a pull dropped a stored one.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import collectSiteContent, { processMarkdownFile } from '../src/site/content-collector.js'
import { dropHiddenSections } from '../src/site/nav-visibility.js'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

let dir
let warnings
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'section-hidden-'))
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
  'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/1-hero.md': '---\ntype: Hero\n---\n\n# Hi\n',
  'pages/home/2-draft.md': '---\ntype: Features\nhidden: true\nlayout: grid\n---\n\n# Not yet\n',
  'layout/header.md': '---\ntype: Header\nhidden: true\n---\n\n# Menu\n',
}

describe('the collector', () => {
  it('takes `hidden: true` out of the params and marks the section', async () => {
    write(dir, { 'draft.md': site['pages/home/2-draft.md'] })
    const { section } = await processMarkdownFile(join(dir, 'draft.md'), '0', dir)
    expect(section.hidden).toBe(true)
    expect(section.params).toEqual({ layout: 'grid' })
    expect(warnings).toEqual([])
  })

  it('leaves a visible section unmarked, `hidden: false` included', async () => {
    write(dir, { 'shown.md': '---\ntype: Hero\nhidden: false\n---\n' })
    const { section } = await processMarkdownFile(join(dir, 'shown.md'), '0', dir)
    expect(section).not.toHaveProperty('hidden')
    expect(section.params).toEqual({})
  })

  it('warns on a value that is not true or false, and keeps the section visible', async () => {
    write(dir, { 'odd.md': '---\ntype: Hero\nhidden: "yes"\n---\n' })
    const { section } = await processMarkdownFile(join(dir, 'odd.md'), '0', dir)
    expect(section).not.toHaveProperty('hidden')
    expect(section.params).toEqual({})
    expect(warnings.join('\n')).toMatch(/hidden: "yes" is not true or false/)
  })
})

describe('the build', () => {
  const typesOf = (page) => page.sections.map((s) => s.type)

  it('a published build leaves hidden sections out, in pages and layout areas alike', async () => {
    write(dir, site)
    const { pages } = await collectSiteContent(dir, { dropUnpublished: true })
    expect(typesOf(pages.find((p) => p.route === '/'))).toEqual(['Hero'])
  })

  it('an area whose sections are all hidden is left out whole, not kept empty', async () => {
    write(dir, { ...site, 'layout/footer.md': '---\ntype: Footer\n---\n\n# Footer\n' })
    const { layouts } = await collectSiteContent(dir, { dropUnpublished: true })
    expect(layouts.default).not.toHaveProperty('header')
    expect(layouts.default.footer.sections.map((s) => s.type)).toEqual(['Footer'])
  })

  it('dev keeps them, so a draft stays previewable', async () => {
    write(dir, site)
    const { pages, layouts } = await collectSiteContent(dir)
    expect(typesOf(pages.find((p) => p.route === '/'))).toEqual(['Hero', 'Features'])
    expect(layouts.default.header.sections.map((s) => s.hidden)).toEqual([true])
  })

  it('a hidden section takes its child sections with it, and a hidden child goes alone', () => {
    const sections = [
      { id: '1', type: 'Grid', subsections: [{ id: '1_1', type: 'Card' }, { id: '1_2', type: 'Card', hidden: true }] },
      { id: '2', type: 'Grid', hidden: true, subsections: [{ id: '2_1', type: 'Card' }] },
    ]
    expect(dropHiddenSections(sections)).toEqual([
      { id: '1', type: 'Grid', subsections: [{ id: '1_1', type: 'Card' }] },
    ])
  })
})

describe('the sync wire', () => {
  it('sends the section with its own `hidden`, not as a param', async () => {
    write(dir, site)
    const doc = await siteProjectToDocument(dir)
    const [hero, draft] = doc.pages[0].page_sections
    expect(hero).not.toHaveProperty('hidden')
    expect(draft.hidden).toBe(true)
    expect(draft.params).toEqual({ layout: 'grid' })
  })

  it('round-trips: a pull writes `hidden: true` back, and a push sends it again', async () => {
    write(dir, site)
    const doc = await siteProjectToDocument(dir)
    const dest = mkdtempSync(join(tmpdir(), 'section-hidden-pulled-'))
    try {
      siteContentDocumentToProject({ document: doc, siteRoot: dest })
      // A fresh pull names each file by its stable id.
      expect(readFileSync(join(dest, 'pages/home/draft.md'), 'utf8')).toMatch(/^type: Features\nhidden: true$/m)
      expect(readFileSync(join(dest, 'pages/home/hero.md'), 'utf8')).not.toMatch(/hidden/)
      expect(await siteProjectToDocument(dest)).toEqual(doc)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('a pull of a section the store shows removes a stale `hidden:` from the file', async () => {
    write(dir, site)
    const doc = await siteProjectToDocument(dir)
    doc.pages[0].page_sections[1].hidden = false // un-hidden in an editor
    siteContentDocumentToProject({ document: doc, siteRoot: dir })
    const file = readFileSync(join(dir, 'pages/home/2-draft.md'), 'utf8')
    expect(file).not.toMatch(/hidden/)
    expect(file).toMatch(/layout: grid/)
  })

  it('reads a `hidden` an earlier push left inside the params', async () => {
    write(dir, site)
    const doc = await siteProjectToDocument(dir)
    const draft = doc.pages[0].page_sections[1]
    delete draft.hidden
    draft.params = { ...draft.params, hidden: true } // what a push sent before 2026-09-28
    const dest = mkdtempSync(join(tmpdir(), 'section-hidden-legacy-'))
    try {
      siteContentDocumentToProject({ document: doc, siteRoot: dest })
      const file = readFileSync(join(dest, 'pages/home/draft.md'), 'utf8')
      expect(file.match(/hidden: true/g)).toHaveLength(1)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
