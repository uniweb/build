/**
 * ⭐ A DOCUMENT FOLDER CAN REDIRECT. A directory holding only its `folder.yml`, with `redirect:` (or
 * `rewrite:`), is a page that holds no section and sends visitors on, as a directory holding only a
 * `page.yml` is in page mode. That is how a moved page keeps its old address in folder mode. It is one
 * page on every lane: the build (`uniweb dev` and a static build), the push and the pull
 * (`site/content-collector.js::documentFolderRedirect`).
 *
 * ⛔ Until 2026-11-21 the build dropped it while the push sent it: a hosted site redirected, and
 * `uniweb dev` and a static build showed an empty page at the same address.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { buildRouteOf } from '../src/uwx/site.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const siteDir = () => join(ROOT, 'site')
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'document-folder-redirect-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const snapshot = () => {
  const files = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '.uniweb') continue
      if (statSync(p).isDirectory()) walk(p)
      else files[relative(ROOT, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(ROOT)
  return files
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort()
const pageAt = (doc, canon) => {
  const walk = (records, parent) => {
    for (const r of records || []) {
      const route = buildRouteOf(r, parent, 'en')
      if (route === canon) return r
      const found = walk(r.$children, route)
      if (found) return found
    }
    return null
  }
  return walk(doc.pages, '/')
}
const builtPage = async (route) => (await collectSiteContent(siteDir(), {})).pages.find((p) => p.route === route)

// A manual in folder mode whose page `the-sdk` moved from `docs/sdk` into `docs/web-apps/`, leaving its
// old address behind as a directory that holds only its `folder.yml`.
function manual() {
  w('site/site.yml', 'name: S\nfoundation: "@acme/base@1.0.0"\nindex: home\n')
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/hero.md', '# Welcome\n')
  w('site/pages/docs/folder.yml', 'title: Docs\n')
  w('site/pages/docs/intro.md', '# Intro\n\nHello.\n')
  w('site/pages/docs/web-apps/folder.yml', 'title: Web apps\n')
  w('site/pages/docs/web-apps/the-sdk.md', '# The SDK\n\nText.\n')
  w('site/pages/docs/sdk/folder.yml', "redirect: ../web-apps/the-sdk\nhideIn: ['*']\n")
}

describe('⭐ the build gives a document folder its redirect', () => {
  it('resolved against its own route, with no section, and never indexed', async () => {
    manual()
    const page = await builtPage('/docs/sdk')
    expect(page).toMatchObject({ redirect: '/docs/web-apps/the-sdk', seo: { noindex: true }, hasContent: false })
    expect(page.sections).toEqual([])
  })

  it('in a site in page mode too, where a directory with a `folder.yml` starts folder mode', async () => {
    w('site/site.yml', 'name: S\nfoundation: "@acme/base@1.0.0"\nindex: home\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Welcome\n')
    w('site/pages/guide/folder.yml', 'redirect: /\n')
    expect(await builtPage('/guide')).toMatchObject({ redirect: '/', seo: { noindex: true } })
  })

  it('and its `rewrite:`', async () => {
    manual()
    w('site/pages/docs/api/folder.yml', 'rewrite: https://api.example.com\n')
    expect(await builtPage('/docs/api')).toMatchObject({ rewrite: 'https://api.example.com', seo: { noindex: true } })
  })

  it('a document folder without one is unchanged', async () => {
    manual()
    const page = await builtPage('/docs/web-apps')
    expect('redirect' in page).toBe(false)
    expect(page.seo.noindex).toBe(false)
  })
})

describe('⭐ the push and the pull carry it as the build reads it', () => {
  it('the push sends it as the document folder\'s, and a pull of what was pushed changes no file', async () => {
    manual()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    expect(pageAt(doc, '/docs/sdk')).toMatchObject({ mode: 'atomic-parent', redirect: '../web-apps/the-sdk', hide_in: ['*'] })
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })
    expect(changed(before, snapshot())).toEqual([])
  })

  it('a redirect the app gives a document folder lands in its `folder.yml`, and the build then reads it', async () => {
    manual()
    const doc = await siteProjectToDocument(siteDir())
    pageAt(doc, '/docs/web-apps').redirect = '/docs/intro'
    const report = siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })
    expect(report.held).toEqual([])
    expect(read('site/pages/docs/web-apps/folder.yml')).toContain('redirect: /docs/intro')
    expect(await builtPage('/docs/web-apps')).toMatchObject({ redirect: '/docs/intro' })
  })
})
