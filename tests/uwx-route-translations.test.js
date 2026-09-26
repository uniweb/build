/**
 * ⭐ LOCALIZED URLS TRAVEL — in each page's localized `slug`, and back into the form the site keeps them in.
 *
 * Measured 2026-09-26 on the `international` template: its `site.yml` gives `/about` the Spanish URL
 * `/acerca-de`, and a clone came back with no `i18n.routeTranslations` — every localized URL gone. The
 * push sent each page's source slug alone, though the site-content Model declares `slug` localized.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

const ROUTES = {
  es: { '/about': '/acerca-de', '/blog': '/noticias', '/blog/news': '/noticias/novedades' },
  fr: { '/about': '/a-propos', '/contact': '/contact' },
}

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'uwx-routes-'))
  dirs.push(d)
  return d
}
const write = (root, rel, body) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

function project({ routes = ROUTES, pageSlugs = {} } = {}) {
  const root = tmp()
  const i18n = routes ? `# Localized URLs\ni18n:\n  routeTranslations:\n${yaml.dump(routes).replace(/^/gm, '    ')}` : ''
  write(root, 'site.yml', `name: Site\ndefaultLanguage: en\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n${i18n}`)
  for (const page of ['home', 'about', 'contact', 'blog', 'blog/news']) {
    const slug = pageSlugs[page] ? `slug:\n${yaml.dump(pageSlugs[page]).replace(/^/gm, '  ')}` : ''
    write(root, `pages/${page}/page.yml`, `title: ${page}\n${slug}`)
    write(root, `pages/${page}/hero.md`, `---\ntype: Hero\n---\n# ${page}\n`)
  }
  write(root, 'locales/es.json', '{}')
  write(root, 'locales/fr.json', '{}')
  return root
}

const pageOf = (doc, ...path) => {
  let level = doc.pages
  let page
  for (const slug of path) {
    page = level.find((p) => p.slug?.en === slug)
    level = page?.$children || []
  }
  return page
}
const builtRoutes = async (root) => (await collectSiteContent(root)).config?.i18n?.routeTranslations

describe('push — each page’s localized segments ride in its `slug`', () => {
  it('⭐ from `site.yml`’s `i18n.routeTranslations`, taken apart per page', async () => {
    const doc = await siteProjectToDocument(project())
    expect(pageOf(doc, 'about').slug).toEqual({ en: 'about', es: 'acerca-de', fr: 'a-propos' })
    expect(pageOf(doc, 'blog').slug).toEqual({ en: 'blog', es: 'noticias' })
    expect(pageOf(doc, 'blog', 'news').slug).toEqual({ en: 'news', es: 'novedades' })
    expect(pageOf(doc, 'contact').slug).toEqual({ en: 'contact', fr: 'contact' })
    expect(pageOf(doc, 'home').slug).toEqual({ en: 'home' })
  })

  it('from the pages’ own `slug:` maps — which the build reads instead of the site’s, as here', async () => {
    const doc = await siteProjectToDocument(project({ pageSlugs: { about: { es: 'sobre' } } }))
    expect(pageOf(doc, 'about').slug).toEqual({ en: 'about', es: 'sobre' })
    expect(pageOf(doc, 'blog').slug).toEqual({ en: 'blog' })
  })

  it('a route that is not its parent’s plus one segment is named, and not sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const doc = await siteProjectToDocument(project({ routes: { es: { '/contact': '/escribenos/contacto' } } }))
      expect(pageOf(doc, 'contact').slug).toEqual({ en: 'contact' })
      expect(warn.mock.calls.flat().join('\n')).toMatch(/\/contact.*\/escribenos\/contacto/)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('pull — the segments go back where the site keeps them', () => {
  it('⭐ a clone gets each page’s `slug:` — the same URLs, by the build’s own reading', async () => {
    const source = project()
    const clone = tmp()
    siteContentDocumentToProject({ document: await siteProjectToDocument(source), siteRoot: clone })
    expect(yaml.load(readFileSync(join(clone, 'pages/about/page.yml'), 'utf8')).slug).toEqual({ es: 'acerca-de', fr: 'a-propos' })
    expect(await builtRoutes(clone)).toEqual(await builtRoutes(source))
  })

  it('⭐ a copy that keeps them in `site.yml` is left as it was', async () => {
    const root = project()
    const before = readFileSync(join(root, 'site.yml'), 'utf8')
    siteContentDocumentToProject({ document: await siteProjectToDocument(root), siteRoot: root })
    expect(yaml.load(readFileSync(join(root, 'site.yml'), 'utf8')).i18n).toEqual(yaml.load(before).i18n)
    expect(yaml.load(readFileSync(join(root, 'pages/about/page.yml'), 'utf8')).slug).toBeUndefined()
  })

  it('a segment changed in the backend is written into `site.yml`’s map', async () => {
    const root = project()
    const doc = await siteProjectToDocument(root)
    pageOf(doc, 'blog').slug.es = 'blog-es'
    siteContentDocumentToProject({ document: doc, siteRoot: root })
    expect(yaml.load(readFileSync(join(root, 'site.yml'), 'utf8')).i18n.routeTranslations).toEqual({
      es: { '/about': '/acerca-de', '/blog': '/blog-es', '/blog/news': '/blog-es/novedades' },
      fr: ROUTES.fr,
    })
  })

  it('⚖️ a page that carries none keeps the `slug:` its page.yml has — a push from before sent none', async () => {
    const root = project({ routes: null, pageSlugs: { about: { es: 'sobre' } } })
    const doc = await siteProjectToDocument(root)
    pageOf(doc, 'about').slug = { en: 'about' }
    siteContentDocumentToProject({ document: doc, siteRoot: root })
    expect(yaml.load(readFileSync(join(root, 'pages/about/page.yml'), 'utf8')).slug).toEqual({ es: 'sobre' })
  })
})
