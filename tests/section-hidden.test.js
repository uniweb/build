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

describe('what a hidden section means for its page', () => {
  it('its heading never titles the page: the first section that publishes does', async () => {
    write(dir, {
      'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
      'pages/home/page.yml': '{}\n',
      'pages/home/1-draft.md': '---\ntype: Hero\nhidden: true\n---\n\n# Draft heading\n',
      'pages/home/2-hero.md': '---\ntype: Hero\n---\n\n# Published heading\n',
    })
    for (const dropUnpublished of [false, true]) {
      const { pages } = await collectSiteContent(dir, { dropUnpublished })
      expect(pages.find((p) => p.route === '/').title).toBe('Published heading')
    }
  })

  it('a page whose sections are all hidden takes its prettified name, and stays a page', async () => {
    write(dir, {
      'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
      'pages/home/page.yml': 'title: Home\n',
      'pages/about-us/page.yml': '{}\n',
      'pages/about-us/draft.md': '---\ntype: Hero\nhidden: true\n---\n\n# Draft heading\n',
    })
    const { pages } = await collectSiteContent(dir, { dropUnpublished: true })
    const about = pages.find((p) => p.route === '/about-us')
    expect(about.title).toBe('About Us')
    expect(about.hasContent).toBe(true)
    expect(about.sections).toEqual([])
  })

  it('in folder mode the file is the page, so its `hidden: true` drafts the page', async () => {
    write(dir, {
      'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
      'pages/home/page.yml': 'title: Home\n',
      'pages/docs/folder.yml': 'title: Docs\n',
      'pages/docs/guide.md': '---\ntype: Article\n---\n\n# Guide\n',
      'pages/docs/draft.md': '---\ntype: Article\nhidden: true\n---\n\n# Draft\n',
    })
    const routes = async (dropUnpublished) =>
      (await collectSiteContent(dir, { dropUnpublished })).pages.map((p) => p.route).filter((r) => r.startsWith('/docs/'))
    expect((await routes(true)).sort()).toEqual(['/docs/guide'])
    expect((await routes(false)).sort()).toEqual(['/docs/draft', '/docs/guide'])
  })
})

describe('a stored background or theme on pull', () => {
  it('comes from `params` alone — the two fields the site-content Model dropped are not read', async () => {
    write(dir, {
      'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
      'pages/home/page.yml': 'title: Home\n',
      'pages/home/hero.md': "---\ntype: Hero\nbackground: '#new'\n---\n\n# Hi\n",
    })
    const doc = await siteProjectToDocument(dir)
    // the two fields as a store kept them before the Model dropped them — a pull ignores
    // both, `theme_override` where `params` has no `theme` too
    Object.assign(doc.pages[0].page_sections[0], { background: '#old', theme_override: 'dark' })
    const dest = mkdtempSync(join(tmpdir(), 'section-fields-pulled-'))
    try {
      siteContentDocumentToProject({ document: doc, siteRoot: dest })
      const file = readFileSync(join(dest, 'pages/home/hero.md'), 'utf8')
      expect(file).toMatch(/background: '#new'/)
      expect(file).not.toMatch(/#old|theme:/)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})

describe('a section’s data on the wire — `params.fetch` [2026-09-28]', () => {
  const dataSite = {
    'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
    'pages/home/page.yml': 'title: Home\n',
    'pages/home/team.md': '---\ntype: Team\nquery: members\n---\n\n# Team\n',
  }

  it('a push sends it in `params`, and still as the field, equal', async () => {
    write(dir, dataSite)
    const section = (await siteProjectToDocument(dir)).pages[0].page_sections[0]
    expect(section.params.fetch).toBeTruthy()
    expect(section.params.fetch).toEqual(section.fetch)
  })

  it('a pull writes the declaration back from `params.fetch`, which wins over a stored field', async () => {
    write(dir, dataSite)
    const doc = await siteProjectToDocument(dir)
    const section = doc.pages[0].page_sections[0]
    section.fetch = { query: 'old-query' } // a field an earlier push left in a store
    const dest = mkdtempSync(join(tmpdir(), 'section-fetch-pulled-'))
    try {
      siteContentDocumentToProject({ document: doc, siteRoot: dest })
      const file = readFileSync(join(dest, 'pages/home/team.md'), 'utf8')
      expect(file).toMatch(/query: members/)
      expect(file).not.toMatch(/old-query|^fetch:/m)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
