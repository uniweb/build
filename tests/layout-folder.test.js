/**
 * A site's `layout/` folder is read from the site alone, and every producer reads it
 * the same way: the build (`collectSiteContent` → `layouts`), the sync producer
 * (`siteProjectToDocument` → `layout_sections`) and the pull, which writes it back.
 *
 * ⛔ Before 2026-09-13 the build called a folder under `layout/` a named layout only
 * when the foundation declared a layout by that name, and sync called every folder a
 * named layout — so the documented `layout/header/1-topbar.md` was the default
 * layout's header on a static build and a layout named `header` once synced.
 * The first case below was red against that code.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { collectSiteContent } from '../src/site/content-collector.js'
import { readLayoutFolder, _resetLayoutFolderWarnings } from '../src/site/layout-folder.js'
import { siteProjectToDocument } from '../src/uwx/site.js'
import { siteContentDocumentToProject, layoutSectionPaths } from '../src/uwx/site-project.js'
import { collectSiteUnits } from '../src/uwx/site-diff.js'

const dirs = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  _resetLayoutFolderWarnings()
})

/** A site with a home page and the given files, relative to the site root. */
function site(files) {
  const root = mkdtempSync(join(tmpdir(), 'uniweb-layout-folder-'))
  dirs.push(root)
  const all = {
    'site.yml': 'name: probe\nfoundation: "@acme/foundation@1.0.0"\n',
    'pages/home/1-hero.md': '---\ntype: Hero\n---\n# Home\n',
    ...files,
  }
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

const section = (type) => `---\ntype: ${type}\n---\n${type}\n`

/** `{ layout: { area: [types] } }` from the build's payload. */
async function builtLayouts(root) {
  const quiet = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const { layouts } = await collectSiteContent(root, {})
    const out = {}
    for (const [layout, areas] of Object.entries(layouts || {})) {
      out[layout] = {}
      for (const [area, page] of Object.entries(areas)) out[layout][area] = page.sections.map((s) => s.type)
    }
    return out
  } finally {
    quiet.mockRestore()
  }
}

/** `{ layout: { area: [types] } }` from the sync document. */
async function syncedLayouts(root) {
  const { layout_sections } = await siteProjectToDocument(root)
  const out = {}
  for (const s of layout_sections || []) {
    out[s.layout_name] ??= {}
    ;(out[s.layout_name][s.area] ??= []).push(s.type)
  }
  return out
}

describe('the layout folder, read the same by the build and by sync', () => {
  it('⛔ a folder under layout/ is a named layout — the documented multi-section header included', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = site({
        'layout/header/1-topbar.md': section('TopBar'),
        'layout/header/2-navbar.md': section('Navbar'),
      })
      const expected = { header: { topbar: ['TopBar'], navbar: ['Navbar'] } }
      expect(await builtLayouts(root)).toEqual(expected)
      expect(await syncedLayouts(root)).toEqual(expected)
    } finally {
      warn.mockRestore()
    }
  })

  it('reads every form of the convention identically, with no foundation present', async () => {
    const root = site({
      'layout/header.md': section('Header'),
      'layout/footer.md': section('Footer'),
      'layout/docs/header.md': section('DocsHeader'),
      'layout/docs/sidebar/1-nav.md': section('Nav'),
      'layout/docs/sidebar/2-search.md': section('Search'),
      'layout/default/left/1-a.md': section('A'),
      'layout/default/left/2-b.md': section('B'),
    })
    const expected = {
      default: { footer: ['Footer'], header: ['Header'], left: ['A', 'B'] },
      docs: { header: ['DocsHeader'], sidebar: ['Nav', 'Search'] },
    }
    expect(await builtLayouts(root)).toEqual(expected)
    expect(await syncedLayouts(root)).toEqual(expected)
  })

  it('orders an area folder by numeric prefix, as a page orders its sections', async () => {
    const root = site({
      'layout/docs/sidebar/10-last.md': section('Last'),
      'layout/docs/sidebar/2-second.md': section('Second'),
      'layout/docs/sidebar/1-first.md': section('First'),
    })
    expect((await builtLayouts(root)).docs.sidebar).toEqual(['First', 'Second', 'Last'])
    expect((await syncedLayouts(root)).docs.sidebar).toEqual(['First', 'Second', 'Last'])
  })

  it('keeps a one-section area\'s stable id as the area name, and names a folder\'s sections by file', async () => {
    const root = site({
      'layout/header.md': section('Header'),
      'layout/docs/sidebar/1-nav.md': section('Nav'),
      'layout/docs/sidebar/2-search.md': section('Search'),
    })
    const { layout_sections } = await siteProjectToDocument(root)
    expect(layout_sections.map((s) => s.$id)).toEqual(['header', 'nav', 'search'])
  })

  it('warns once when a layout folder is named like a conventional area', async () => {
    const root = site({ 'layout/footer/footer.md': section('Footer') })
    const warnings = []
    await readLayoutFolder(join(root, 'layout'), { siteRoot: root, onWarning: (m) => warnings.push(m) })
    await readLayoutFolder(join(root, 'layout'), { siteRoot: root, onWarning: (m) => warnings.push(m) })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/layout\/footer\/ is the layout named `footer`/)
    expect(warnings[0]).toMatch(/layout\/footer\.md/)
    expect(warnings[0]).toMatch(/layout\/default\/footer\//)
  })

  it('puts a layout section\'s assets and icons in the site\'s manifests', async () => {
    const root = site({
      'layout/header.md': '---\ntype: Header\n---\n# Site\n\n![Logo](./logo.png)\n\n![](lu-house)\n',
      'layout/logo.png': 'x',
    })
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const content = await collectSiteContent(root, {})
      expect(Object.keys(content.assets).some((k) => k.endsWith('logo.png'))).toBe(true)
      expect(JSON.stringify(content.icons)).toContain('house')
    } finally {
      quiet.mockRestore()
    }
  })
})

describe('what the layout folder refuses', () => {
  const refusal = async (files) => {
    const root = site(files)
    try {
      await readLayoutFolder(join(root, 'layout'), { siteRoot: root, onWarning: () => {} })
    } catch (err) {
      return err.message
    }
    return null
  }

  it('a page.yml in an area folder', async () => {
    expect(await refusal({
      'layout/docs/header/1-a.md': section('A'),
      'layout/docs/header/page.yml': 'title: Header\n',
    })).toMatch(/layout\/docs\/header\/page\.yml: a layout folder holds no page\.yml/)
  })

  it('a child section', async () => {
    expect(await refusal({
      'layout/docs/header/1-a.md': section('A'),
      'layout/docs/header/@child.md': section('Child'),
    })).toMatch(/no child sections/)
  })

  it('one area declared twice — a root file and the default layout folder', async () => {
    expect(await refusal({
      'layout/header.md': section('Header'),
      'layout/default/header.md': section('Header2'),
    })).toMatch(/both declare the `header` area of the default layout/)
  })

  it('one area declared twice — a file and a folder in one layout', async () => {
    expect(await refusal({
      'layout/docs/header.md': section('Header'),
      'layout/docs/header/1-a.md': section('A'),
    })).toMatch(/both declare the `header` area of the `docs` layout/)
  })

  it('markdown nested inside an area folder', async () => {
    expect(await refusal({
      'layout/docs/header/1-a.md': section('A'),
      'layout/docs/header/deeper/x.md': section('X'),
    })).toMatch(/nothing nests inside a layout area/)
  })

  it('stops the build, not only the reader', async () => {
    const root = site({ 'layout/docs/header/page.yml': 'title: x\n', 'layout/docs/header/1-a.md': section('A') })
    await expect(collectSiteContent(root, {})).rejects.toThrow(/holds no page\.yml/)
  })
})

describe('the pull writes the layout folder the reader reads', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const info = { name: { en: 'S' }, foundation: '@a/base' }
  const lsec = (layout_name, area, id, type) => ({ $id: id, stable_id: id, layout_name, area, type, content: docOf(type) })
  const layout_sections = [
    lsec('default', 'header', 'header', 'Header'),
    lsec('docs', 'sidebar', 'nav', 'Nav'),
    lsec('docs', 'sidebar', 'search', 'Search'),
    lsec('default', 'left', 'a', 'A'),
    lsec('default', 'left', 'b', 'B'),
  ]

  it('places one-section areas as files and multi-section areas as prefixed folders', () => {
    expect(layoutSectionPaths(layout_sections).map((p) => p.relPath)).toEqual([
      'header.md',
      'docs/sidebar/1-nav.md',
      'docs/sidebar/2-search.md',
      'default/left/1-a.md',
      'default/left/2-b.md',
    ])
  })

  it('round-trips through the reader into the same layouts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uniweb-layout-pull-'))
    dirs.push(root)
    siteContentDocumentToProject({ document: { info, pages: [], layout_sections }, siteRoot: root })
    const areas = await readLayoutFolder(join(root, 'layout'), { siteRoot: root, onWarning: () => {} })
    expect(areas.map((a) => `${a.layout}/${a.area}:${a.files.length}`)).toEqual([
      'default/header:1',
      'default/left:2',
      'docs/sidebar:2',
    ])
  })

  it('prunes an emptied area folder and leaves drafts alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'uniweb-layout-prune-'))
    dirs.push(root)
    siteContentDocumentToProject({ document: { info, pages: [], layout_sections }, siteRoot: root })
    writeFileSync(join(root, 'layout/docs/_draft.md'), 'draft')
    // The sidebar shrinks to one section — it becomes a file, and its folder goes.
    const next = [lsec('default', 'header', 'header', 'Header'), lsec('docs', 'sidebar', 'nav', 'Nav')]
    siteContentDocumentToProject({ document: { info, pages: [], layout_sections: next }, siteRoot: root, prune: true })
    expect(existsSync(join(root, 'layout/docs/sidebar.md'))).toBe(true)
    expect(existsSync(join(root, 'layout/docs/sidebar'))).toBe(false)
    expect(existsSync(join(root, 'layout/default'))).toBe(false)
    expect(readdirSync(join(root, 'layout/docs')).sort()).toEqual(['_draft.md', 'sidebar.md'])
  })

  it('keys each layout section in the site diff by that path, so layouts cannot collide', () => {
    const units = collectSiteUnits({
      info,
      pages: [],
      layout_sections: [lsec('default', 'footer', 'footer', 'F'), lsec('marketing', 'footer', 'footer', 'MF')],
    })
    expect([...units.keys()].filter((k) => k.startsWith('layout/'))).toEqual(['layout/footer.md', 'layout/marketing/footer.md'])
  })
})

describe('a trailing `Layout` is optional in a folder name (ruled 2026-09-13)', () => {
  it('`layout/docs/` and `layout/DocsLayout/` name one layout — keeping both stops the build', async () => {
    const root = site({ 'layout/docs/header.md': section('DocsHeader'), 'layout/DocsLayout/footer.md': section('DocsFooter') })
    await expect(readLayoutFolder(join(root, 'layout'))).rejects.toThrow(/name one layout — layout names match regardless of case and of a trailing `Layout`/)
  })

  it('`layout/DefaultLayout/` is the default layout written as a folder', async () => {
    const root = site({ 'layout/DefaultLayout/header.md': section('Header') })
    const areas = await readLayoutFolder(join(root, 'layout'))
    expect(areas.map((a) => [a.layout, a.area])).toEqual([['default', 'header']])
  })
})
