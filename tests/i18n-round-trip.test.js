/**
 * ⭐ A SITE'S LANGUAGES SURVIVE SYNC — measured by what the site renders in each of them.
 *
 * A push and a pull into the author's copy, and a push and a pull into an empty directory (a clone),
 * must each leave a site that renders every language as the site itself does. Compared by what a
 * visitor reads — each page's title, each section's text and data-block values, each layout area's,
 * the declared languages and the localized routes — through the link build's own i18n pipeline
 * (`buildSiteData`, then `buildLocalizedContent`), not by the files: a clone cannot reproduce how the
 * author spelled things, and need not.
 *
 * Measured 2026-09-26 on the `international` template and variants of it through a local backend;
 * these are the same checks, run in-process, one i18n feature per case.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { buildSiteData } from '../src/site/index.js'
import { buildLocalizedContent } from '../src/i18n/index.js'
import { resolveLocaleList } from '../src/i18n/locales.js'
import { computeHash } from '../src/i18n/hash.js'

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'i18n-round-trip-'))
  dirs.push(d)
  return d
}
const write = (root, files) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
  }
}
const h = computeHash

// A small site in English and Spanish; each case adds the feature it is about.
function site({ siteYml = '', localesDir = 'locales', es = {}, files = {} } = {}) {
  const root = tmp()
  write(root, {
    'site.yml': `name: Site\ndefaultLanguage: en\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n${siteYml}`,
    'pages/home/page.yml': 'title: Home\n',
    'pages/home/1-hero.md': '---\ntype: Hero\n---\n\n# Welcome\n\nWe protect pandas.\n\n[Support us](/about)\n',
    'pages/about/page.yml': 'title: About\n',
    'pages/about/1-intro.md': '---\ntype: Section\n---\n\n# Our story\n\nIt began in 2008.\n',
    'layout/footer.md': '---\ntype: Footer\n---\n\n# Site\n\nAll rights reserved.\n',
    [`${localesDir}/es.json`]: {
      [h('Home')]: 'Inicio',
      [h('About')]: 'Acerca de',
      [h('Welcome')]: 'Bienvenidos',
      [h('We protect pandas.')]: 'Protegemos a los pandas.',
      [h('Support us')]: '[Apóyanos](/about)',
      [h('Our story')]: 'Nuestra historia',
      [h('It began in 2008.')]: 'Empezó en 2008.',
      [h('Site')]: 'Sitio',
      [h('All rights reserved.')]: 'Todos los derechos reservados.',
      ...es,
    },
    ...files,
  })
  return root
}

// The text a visitor reads, and the values of data blocks.
function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out))
  else if (node && typeof node === 'object') {
    if (node.type === 'text') out.push(node.text)
    if (node.type === 'dataBlock') out.push(`data:${JSON.stringify(node.attrs?.data)}`)
    for (const [k, v] of Object.entries(node)) if (k !== 'attrs' && v && typeof v === 'object') texts(v, out)
  }
  return out
}
const page = (p) => ({ title: p.title ?? null, sections: Object.fromEntries((p.sections || []).map((s) => [s.stableId, texts(s.content).join(' | ')])) })
function summary(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'))
  return {
    languages: (c.config?.languages || []).map((l) => (typeof l === 'string' ? l : l.code)),
    routes: c.config?.i18n?.routeTranslations ?? null,
    pages: Object.fromEntries((c.pages || []).map((p) => [p.route, page(p)])),
    layouts: Object.fromEntries(Object.entries(c.layouts || {}).flatMap(([n, areas]) => Object.entries(areas || {}).map(([a, p]) => [`${n}/${a}`, page(p)]))),
  }
}

// What a site renders in each of its languages.
async function rendered(siteRoot) {
  const root = join(tmp(), 'site')
  cpSync(siteRoot, root, { recursive: true })
  const config = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8')) || {}
  const localesDir = config.i18n?.localesDir || 'locales'
  let locales = resolveLocaleList(config.languages, join(root, localesDir))
  if (config.publishLanguages) locales = locales.filter((l) => config.publishLanguages.includes(l))
  const quiet = [console.log, console.warn]
  console.log = console.warn = () => {}
  try {
    await buildSiteData({ siteRoot: root, distDir: join(root, 'dist'), foundationPath: null, assets: { process: false } })
    if (locales.length) await buildLocalizedContent(root, { locales, localesDir, generateSearchIndexes: false })
  } finally {
    ;[console.log, console.warn] = quiet
  }
  const out = { en: summary(join(root, 'dist', 'site-content.json')) }
  for (const l of locales) if (l !== 'en') out[l] = summary(join(root, 'dist', l, 'site-content.json'))
  return out
}

// A push, then a pull into the author's copy and into an empty directory.
async function roundTrip(src) {
  const wire = JSON.stringify(await siteProjectToDocument(src))
  const copy = join(tmp(), 'site')
  cpSync(src, copy, { recursive: true })
  siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: copy, prune: true })
  const clone = tmp()
  siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: clone, prune: true })
  return { copy, clone }
}

async function expectRoundTrip(src, check) {
  const before = await rendered(src)
  check?.(before) // the feature is there to lose
  const { copy, clone } = await roundTrip(src)
  expect(await rendered(copy), 'the author’s copy after a pull').toEqual(before)
  expect(await rendered(clone), 'a clone').toEqual(before)
}

describe('i18n through sync — every language renders the same after a round trip', () => {
  it('per-string translations of pages and layout, localized titles and a localized URL', async () => {
    const src = site({ files: { 'pages/about/page.yml': 'title: About\nslug:\n  es: acerca-de\n' } })
    await expectRoundTrip(src, (r) => {
      expect(r.es.pages['/'].sections.hero).toContain('Protegemos a los pandas.')
      expect(r.es.pages['/about'].title).toBe('Acerca de')
      expect(r.es.routes).toEqual({ es: { '/about': '/acerca-de' } })
      expect(r.es.layouts['default/footer'].sections.footer).toContain('Todos los derechos reservados.')
    })
  })

  it('T1 — a site whose `languages:` names objects is told to name codes', async () => {
    const src = site({ siteYml: 'languages:\n  - code: en\n    label: English\n  - code: es\n    label: Español\n' })
    await expect(siteProjectToDocument(src)).rejects.toThrow(/plain string 'en'/)
  })

  it('T2 — translations kept in a custom `i18n.localesDir`', async () => {
    const src = site({ siteYml: 'i18n:\n  localesDir: translations\n', localesDir: 'translations' })
    await expectRoundTrip(src, (r) => expect(r.es.pages['/'].sections.hero).toContain('Protegemos a los pandas.'))
  })

  it('T3 — a layout area’s free-form translation', async () => {
    const src = site({ files: { 'locales/freeform/es/pages/layout/footer/footer.md': '# Sitio\n\nProtegemos a los pandas.\n\n### Aviso legal\n' } })
    await expectRoundTrip(src, (r) => expect(r.es.layouts['default/footer'].sections.footer).toContain('Aviso legal'))
  })

  it('a homepage section’s free-form translation — addressed at `/`, where the build reads it', async () => {
    const src = site({ files: { 'locales/freeform/es/pages/hero.md': '# Bienvenidos\n\nUn texto libre.\n\n## Y un título más\n' } })
    await expectRoundTrip(src, (r) => expect(r.es.pages['/'].sections.hero).toContain('Un texto libre.'))
  })

  it('T4 — a context-specific override, keyed by the section’s stable id', async () => {
    const src = site({
      files: { 'pages/home/2-more.md': '---\ntype: Section\n---\n\nLearn more.\n', 'pages/about/2-more.md': '---\ntype: Section\n---\n\nLearn more.\n' },
      es: { [h('Learn more.')]: { default: 'Más información.', overrides: { '/about:more': 'Conoce nuestra historia.' } } },
    })
    await expectRoundTrip(src, (r) => {
      expect(r.es.pages['/'].sections.more).toBe('Más información.')
      expect(r.es.pages['/about'].sections.more).toBe('Conoce nuestra historia.')
    })
  })

  it('a page title’s override — the page’s `<route>:_meta`, as the build keys page metadata', async () => {
    const src = site({
      files: { 'pages/story/page.yml': 'title: About\n', 'pages/story/1-text.md': '---\ntype: Section\n---\n\nIt began in 2008.\n' },
      es: { [h('About')]: { default: 'Acerca de', overrides: { '/about:_meta': 'Quiénes somos' } } },
    })
    await expectRoundTrip(src, (r) => {
      expect(r.es.pages['/about'].title).toBe('Quiénes somos')
      expect(r.es.pages['/story'].title).toBe('Acerca de')
    })
  })

  it('T5 — the values of a tagged data block', async () => {
    const src = site({
      files: { 'pages/home/2-links.md': '---\ntype: Section\n---\n\n```yaml:links\n- label: Read our report\n  href: /about\n```\n' },
      es: { [h('Read our report')]: 'Lee nuestro informe' },
    })
    await expectRoundTrip(src, (r) => expect(r.es.pages['/'].sections.links).toContain('Lee nuestro informe'))
  })
})
