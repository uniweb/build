/**
 * ⛔ THE SYNC LANE IS A STRICT SUBSET OF THE BUILD LANE, AND IT USED TO SAY SO
 * NOWHERE.
 *
 * Two authored features the build supports in full and this lane does not map at
 * all — folder-mode `.md`-as-pages, and `paths: { pages/<segment>: … }` sub-mounts.
 * Both are named as v0 mapper gaps in `kb/framework/plans/bidirectional-sync.md`
 * and in `src/uwx/site.js`'s own header, so neither is a surprise. What WAS a
 * surprise is that a site hitting them pushes a fraction of itself with every CLI
 * instrument reporting success.
 *
 * ⭐ Measured 2026-09-18, in a channel with backend, on a 49-page documentation
 * site: `uniweb publish` put 2 pages on the backend, `uniweb status` said
 * "✓ Synced" and `uniweb push` said "✓ Nothing to push", and 36 of 49 live routes
 * returned 404. Nothing was broken — `status` and `push` compare the built
 * document against what was last sent, and the pages were already absent from the
 * document. ⇒ **The loss is upstream of every diff, so it can only be reported
 * where it happens.** That is what these tests pin.
 *
 * ⚠️ They assert the WARNING, not the gap. When either gap closes, the warning
 * goes and so does its test — but until then, removing the warning silently
 * restores a defect that took a live edge deployment and 49 HTTPS probes to find.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT
let warnings
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-silent-loss-'))
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((m) => warnings.push(String(m)))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const site = 'name: test-site\nfoundation: "@acme/base@1.0.0"\n'

describe('folder-mode `.md`-as-pages are skipped, and now say so', () => {
  it('names the folder, the count and every file that will not be pushed', async () => {
    w('site.yml', site)
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('pages/docs/getting-started/folder.yml', 'title: Getting Started\n')
    w('pages/docs/getting-started/what-is-uniweb.md', '# What is Uniweb\n')
    w('pages/docs/getting-started/quickstart.md', '# Quickstart\n')

    const doc = await siteProjectToDocument(ROOT)

    // The gap itself — unchanged, and the reason the warning has to exist.
    const docs = doc.pages.find((p) => p.$id === 'docs')
    const gs = (docs?.$children || []).find((p) => p.$id === 'getting-started')
    expect(gs).toBeDefined()
    expect(gs.$children).toBeUndefined()
    expect(gs.page_sections).toBeUndefined()

    const warn = warnings.find((m) => m.includes('getting-started'))
    expect(warn).toBeDefined()
    expect(warn).toContain('2 page(s)')
    expect(warn).toContain('what-is-uniweb.md')
    expect(warn).toContain('quickstart.md')
    // It must name a way out, or it is only an apology.
    expect(warn).toContain('uniweb export')
  })

  it('applies the build\'s own `isMarkdownFile` rule — no `_` drafts, no README', async () => {
    w('site.yml', site)
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('pages/docs/real.md', '# Real\n')
    w('pages/docs/_draft.md', '# Draft\n')
    w('pages/docs/README.md', '# Repo readme\n')

    await siteProjectToDocument(ROOT)

    const warn = warnings.find((m) => m.includes('will NOT be pushed'))
    expect(warn).toContain('1 page(s)')
    expect(warn).toContain('real.md')
    expect(warn).not.toContain('_draft.md')
    expect(warn).not.toContain('README.md')
  })

  it('CONTROL — a page-mode folder warns about nothing, at any depth', async () => {
    w('site.yml', site)
    // Five levels of page-mode directories: depth is NOT the axis, and a
    // regression that clamped it would show up here rather than as a warning.
    for (const dir of ['a', 'a/b', 'a/b/c', 'a/b/c/d']) {
      w(`pages/${dir}/page.yml`, `title: ${dir}\n`)
      w(`pages/${dir}/hero.md`, '---\ntype: Hero\n---\n\n# Hi\n')
    }

    const doc = await siteProjectToDocument(ROOT)

    let node = doc.pages.find((p) => p.$id === 'a')
    for (const id of ['b', 'c', 'd']) {
      node = (node.$children || []).find((p) => p.$id === id)
      expect(node).toBeDefined()
    }
    expect(warnings.filter((m) => m.includes('will NOT be pushed'))).toHaveLength(0)
  })
})

// ⛔ FOLDER MODE CASCADES, and this lane used to ask only whether a folder HAS a
// `folder.yml`. The documented shape of a docs tree — one `folder.yml` at the top,
// plain folders of `.md` files below it — was pushed as pages of sections: every
// `.md` page merged into its folder's one page, with no warning, and a pull then
// wrote a `page.yml` into the folder so the author's own build merged them too.
describe('folder mode is read the way the build reads it — inherited, and at the root', () => {
  const routes = async () => (await collectSiteContent(ROOT, {})).pages.map((p) => p.route)
  // An explicit homepage, so the build does not promote `docs` to `/` and strip its prefix.
  const withHome = () => {
    w('site.yml', `${site}index: home\n`)
    w('pages/home/page.yml', 'title: Home\n')
    w('pages/home/hero.md', '# Hi\n')
  }
  const find = (pages, ...ids) => ids.reduce((node, id) => (node?.$children ?? node)?.find?.((p) => p.$id === id), pages)

  it('a folder with no config under a folder-mode parent is folder mode, and names its pages', async () => {
    withHome()
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('pages/docs/start/install.md', '# Install\n')
    w('pages/docs/start/quick.md', '# Quick\n')

    // The build: two pages, not one.
    expect(await routes()).toEqual(expect.arrayContaining(['/docs/start/install', '/docs/start/quick']))

    const doc = await siteProjectToDocument(ROOT)
    const start = find(doc.pages, 'docs', 'start')
    expect(start.mode).toBe('folder')
    expect(start.page_sections).toBeUndefined()

    const warn = warnings.find((m) => m.includes('pages/docs/start'))
    expect(warn).toContain('2 page(s)')
    expect(warn).toContain('install.md')
    expect(warn).toContain('quick.md')
    // It must not send the author looking for a `folder.yml` the folder does not have.
    expect(warn).toContain('inherits folder mode')
  })

  it('CONTROL — a `page.yml` under a folder-mode parent is still a page of sections', async () => {
    withHome()
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('pages/docs/guide/page.yml', 'title: Guide\n')
    w('pages/docs/guide/hero.md', '# Guide\n')

    const doc = await siteProjectToDocument(ROOT)
    const guide = find(doc.pages, 'docs', 'guide')
    expect(guide.mode).toBe('page')
    expect(guide.page_sections).toHaveLength(1)
    expect(warnings.filter((m) => m.includes('will NOT be pushed'))).toHaveLength(0)
  })

  it('`pages/folder.yml` puts the whole site in folder mode — top-level pages are named, not dropped silently', async () => {
    w('site.yml', site)
    w('pages/folder.yml', 'title: Site\n')
    w('pages/intro.md', '# Intro\n')
    w('pages/about/about.md', '# About\n')
    w('pages/contact/page.yml', 'title: Contact\n')
    w('pages/contact/form.md', '# Form\n')

    const doc = await siteProjectToDocument(ROOT)

    expect(warnings.find((m) => m.includes('in `pages` will NOT be pushed'))).toContain('intro.md')
    expect(find(doc.pages, 'about').mode).toBe('folder')
    expect(warnings.find((m) => m.includes('pages/about'))).toContain('about.md')
    // CONTROL — a `page.yml` opts back into page mode, at the root as anywhere.
    expect(find(doc.pages, 'contact').mode).toBe('page')
    expect(find(doc.pages, 'contact').page_sections).toHaveLength(1)
  })

  it('a pull of what was pushed leaves the author\'s folder-mode tree as it was', async () => {
    withHome()
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('pages/docs/start/install.md', '# Install\n\nRun it.\n')
    w('pages/docs/start/quick.md', '# Quick\n')
    const before = await routes()

    const doc = await siteProjectToDocument(ROOT)
    siteContentDocumentToProject({ document: doc, siteRoot: ROOT, prune: true })

    // No `page.yml` turned the folder into one page; the files are untouched.
    expect(existsSync(join(ROOT, 'pages/docs/start/page.yml'))).toBe(false)
    expect(readFileSync(join(ROOT, 'pages/docs/start/install.md'), 'utf8')).toBe('# Install\n\nRun it.\n')
    expect(await routes()).toEqual(before)
  })
})

describe('a `pages/<segment>` sub-mount is not read here, and now says so', () => {
  it('warns that the mounted segment pushes as an empty container', async () => {
    w('site.yml', `${site}paths:\n    pages/docs: ./external\n`)
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('external/guide/page.yml', 'title: Guide\n')
    w('external/guide/hero.md', '---\ntype: Hero\n---\n\n# Guide\n')

    const doc = await siteProjectToDocument(ROOT)

    const docs = doc.pages.find((p) => p.$id === 'docs')
    expect(docs).toBeDefined()
    expect(docs.$children).toBeUndefined()

    const warn = warnings.find((m) => m.includes('pages/docs'))
    expect(warn).toBeDefined()
    expect(warn).toContain('NOT read on the sync lane')
    expect(warn).toContain('empty container')
  })

  it('with no local stub, says the route is not pushed at all — there is no container to send', async () => {
    w('site.yml', `${site}paths:\n    pages/docs: ./external\n`)
    w('external/guide/page.yml', 'title: Guide\n')
    w('external/guide/hero.md', '---\ntype: Hero\n---\n\n# Guide\n')

    const doc = await siteProjectToDocument(ROOT)

    expect(doc.pages.find((p) => p.$id === 'docs')).toBeUndefined()
    const warn = warnings.find((m) => m.includes('pages/docs'))
    expect(warn).toContain('will not be pushed at all')
    expect(warn).not.toContain('empty container')
  })

  // A push sends the page tree as ONE entity, so on an already-published site the
  // cost is not "you publish short" — it is that live pages are REMOVED, with the
  // publish still reporting success. Measured by the backend lane 2026-09-18
  // against a current `uniwebd`: 49 stored pages replaced by 2. Both warnings must
  // say so, and asserting it on BOTH is the point — one shared constant, two
  // callers, and nothing else relates them.
  it('BOTH warnings say a republish REMOVES live pages, not merely that it publishes short', async () => {
    w('site.yml', `${site}paths:\n    pages/docs: ./external\n`)
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('pages/guide/folder.yml', 'title: Guide\n')
    w('pages/guide/intro.md', '# Intro\n')
    w('external/thing/page.yml', 'title: Thing\n')

    await siteProjectToDocument(ROOT)

    const mount = warnings.find((m) => m.includes('NOT read on the sync lane'))
    const folderMode = warnings.find((m) => m.includes('folder-mode folder'))
    expect(mount).toBeDefined()
    expect(folderMode).toBeDefined()
    for (const warn of [mount, folderMode]) {
      expect(warn).toContain('REPLACES its whole page tree')
      expect(warn).toContain('REMOVED')
      // The success report is half of why this was invisible — say it.
      expect(warn).toContain('reports success')
    }
  })

  it('CONTROL — the whole-directory form `paths: { pages: … }` IS read, and is silent', async () => {
    w('site.yml', `${site}paths:\n    pages: ./altpages\n`)
    w('altpages/solo/page.yml', 'title: Solo\n')
    w('altpages/solo/hero.md', '---\ntype: Hero\n---\n\n# Solo\n')

    const doc = await siteProjectToDocument(ROOT)

    expect(doc.pages.map((p) => p.$id)).toEqual(['solo'])
    expect(warnings.filter((m) => m.includes('sync lane'))).toHaveLength(0)
    expect(warnings.filter((m) => m.includes('REMOVED'))).toHaveLength(0)
  })
})
