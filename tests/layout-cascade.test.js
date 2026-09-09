/**
 * The `layout:` cascade — site → folder → page, and the WHOLE object.
 *
 * `layout:` is documented in two forms: the string shorthand (`layout: DocsLayout`)
 * and the expanded `{ name, hide, params }` — `docs/reference/page-configuration.md`.
 * `hide` is a non-destructive per-area disable the runtime honours
 * (`core/src/page.js`: `if (this.layout.hide.includes(areaName)) return null`).
 *
 * ⛔ WHAT THESE TESTS WERE WRITTEN FOR. Until 2026-09-09 only `name` cascaded.
 * `hide` and `params` were read from the page's own config alone, so an author
 * writing the documented expanded form in `site.yml` or a `folder.yml` got the
 * name honoured and the other two silently dropped — the shape of bug where the
 * declaration is read, accepted, and never reaches the page.
 *
 * ⚠️ `site.yml::layout` was undocumented while being read for its `.name`
 * (`content-collector.js`), which is what made the gap easy to miss from either
 * side: the docs did not promise it and the code half-honoured it.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { collectSiteContent } from '../src/site/content-collector.js'

let root

/**
 * A site with `pages/<name>/index.md` for each page, plus optional folder.yml files.
 *
 * ⚠️ Every fixture pins `index: home`. Without it the FIRST page alphabetically is
 * promoted to `/` (gotcha 5, route promotion), so `about` silently became the
 * homepage and every route assertion here missed — which is what the first run of
 * this file did.
 */
async function makeSite({ siteYml, pages = {}, folders = {} }) {
  root = await mkdtemp(join(tmpdir(), 'uniweb-layout-'))
  await mkdir(join(root, 'pages'), { recursive: true })
  await writeFile(join(root, 'site.yml'), siteYml)

  for (const [rel, body] of Object.entries(pages)) {
    const full = join(root, 'pages', rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  for (const [rel, body] of Object.entries(folders)) {
    const full = join(root, 'pages', rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  return root
}

const page = (title) => `---\ntype: Hero\n---\n\n# ${title}\n`
const layoutOf = (content, route) => content.pages.find((p) => p.route === route)?.layout

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

describe('layout cascade — site tier', () => {
  it('cascades `hide` from site.yml to every page', async () => {
    const dir = await makeSite({
      siteYml: 'name: T\nindex: home\nlayout:\n  name: DocsLayout\n  hide: [right]\n',
      pages: { 'home/index.md': page('Home'), 'about/index.md': page('About') },
    })
    const content = await collectSiteContent(dir)

    for (const route of ['/', '/about']) {
      expect(layoutOf(content, route).name).toBe('DocsLayout')
      expect(layoutOf(content, route).hide).toEqual(['right'])
    }
  })

  it('cascades `params` from site.yml', async () => {
    const dir = await makeSite({
      siteYml: 'name: T\nindex: home\nlayout:\n  name: DocsLayout\n  params:\n    sidebarWidth: wide\n',
      pages: { 'home/index.md': page('Home') },
    })
    const content = await collectSiteContent(dir)
    expect(layoutOf(content, '/').params).toEqual({ sidebarWidth: 'wide' })
  })

  it('still accepts the string shorthand', async () => {
    const dir = await makeSite({
      siteYml: 'name: T\nindex: home\nlayout: DocsLayout\n',
      pages: { 'home/index.md': page('Home') },
    })
    const content = await collectSiteContent(dir)
    expect(layoutOf(content, '/').name).toBe('DocsLayout')
    expect(layoutOf(content, '/').hide).toBeUndefined()
  })
})

describe('layout cascade — precedence is per field, nearest wins', () => {
  it('a page overrides `hide` without losing the inherited `name`', async () => {
    const dir = await makeSite({
      siteYml: 'name: T\nindex: home\nlayout:\n  name: DocsLayout\n  hide: [right]\n',
      pages: {
        'home/index.md': page('Home'),
        'solo/index.md': page('Solo'),
        'solo/page.yml': 'layout:\n  hide: [footer]\n',
      },
    })
    const content = await collectSiteContent(dir)

    // The page set only `hide`, so the site's `name` still fills the gap —
    // the same "page wins, site fills the gaps" rule `seo` documents.
    expect(layoutOf(content, '/solo').name).toBe('DocsLayout')
    expect(layoutOf(content, '/solo').hide).toEqual(['footer'])
    // and its sibling is untouched
    expect(layoutOf(content, '/').hide).toEqual(['right'])
  })

  it('⛔ REPLACES rather than unions — a page can undo an ancestor hide', async () => {
    // Union would make a site-level `hide` impossible to switch off from a page,
    // which is the one thing an override exists for.
    const dir = await makeSite({
      siteYml: 'name: T\nindex: home\nlayout:\n  hide: [right, footer]\n',
      pages: {
        'home/index.md': page('Home'),
        'wide/index.md': page('Wide'),
        'wide/page.yml': 'layout:\n  hide: []\n',
      },
    })
    const content = await collectSiteContent(dir)
    expect(layoutOf(content, '/wide').hide).toEqual([])
  })

  it('a folder cascades `hide` to its subtree and the site fills the rest', async () => {
    const dir = await makeSite({
      siteYml: 'name: T\nindex: home\nlayout:\n  name: DocsLayout\n  hide: [right]\n',
      pages: {
        'home/index.md': page('Home'),
        'guides/intro/index.md': page('Intro'),
        'other/index.md': page('Other'),
      },
      folders: { 'guides/folder.yml': 'layout:\n  hide: [header]\n' },
    })
    const content = await collectSiteContent(dir)

    expect(layoutOf(content, '/guides/intro').hide).toEqual(['header'])
    expect(layoutOf(content, '/guides/intro').name).toBe('DocsLayout') // from the site
    expect(layoutOf(content, '/other').hide).toEqual(['right']) // untouched by the folder
  })
})
