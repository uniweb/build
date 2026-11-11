/**
 * ⭐ A PAGE IN A BRANCH THE SITE DOESN'T TRANSLATE (`i18n.exclude`) TAKES ONLY A TRANSLATION WRITTEN FOR
 * ITS PLACE (`i18n/extract.js::translationContext`): an override naming the place, or a free-form file
 * for it. A translation of the text wherever it appears does not reach it, on any lane: a build, a push,
 * and what a pull writes for the next push.
 *
 * ⛔ Until 2026-11-11 such a page took the site's translation of any string it shared with the site's
 * own pages: a mounted repo's docs, shown in English on the Spanish site, read the site's slogan and
 * "For developers" in Spanish, since the home page had both.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { computeHash as h } from '../src/i18n/hash.js'
import { mergeTranslations } from '../src/i18n/merge.js'
import { blockElements, elementText } from '../src/i18n/extract.js'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { buildRouteOf } from '../src/uwx/site.js'
import { auditLocale } from '../src/i18n/audit.js'

const ES = { [h('Agents build it')]: 'Los agentes lo construyen', [h('For developers')]: 'Para desarrolladores' }
const texts = (doc) => blockElements(doc).map((element) => elementText(element))

describe('a build', () => {
  const section = (id, markdown) => ({ id, stableId: id, content: markdownToProseMirror(markdown) })
  const site = (exclude) => ({
    config: { defaultLanguage: 'en', ...(exclude ? { i18n: { exclude } } : {}) },
    pages: [
      { route: '/', title: 'Agents build it', sections: [section('hero', '# Agents build it\n\nFor developers')] },
      { route: '/docs', title: 'For developers', sections: [section('intro', '# Agents build it\n\nFor developers')] },
      { route: '/docs/setup', title: 'Setup', sections: [section('steps', 'For developers')] },
    ],
    layouts: { default: { header: { sections: [section('header', 'For developers')] } } },
  })
  const pageAt = (content, route) => content.pages.find((page) => page.route === route)

  it('⭐ shows the source on such a page, where the site translates the same words on its own', () => {
    const es = mergeTranslations(site(['/docs']), ES)
    expect(texts(pageAt(es, '/').sections[0].content)).toEqual(['Los agentes lo construyen', 'Para desarrolladores'])
    expect(texts(pageAt(es, '/docs').sections[0].content)).toEqual(['Agents build it', 'For developers'])
    expect(texts(pageAt(es, '/docs/setup').sections[0].content)).toEqual(['For developers'])
    expect(pageAt(es, '/docs').title).toBe('For developers')
    expect(pageAt(es, '/').title).toBe('Los agentes lo construyen')
  })

  it('CONTROL — with nothing excluded, the same page takes the site’s translation of its words', () => {
    const es = mergeTranslations(site(null), ES)
    expect(texts(pageAt(es, '/docs').sections[0].content)).toEqual(['Los agentes lo construyen', 'Para desarrolladores'])
    expect(pageAt(es, '/docs').title).toBe('Para desarrolladores')
  })

  it('gives such a page a translation written for its place: an override naming a section, or its own words', () => {
    const table = {
      ...ES,
      [h('Agents build it')]: { default: 'Los agentes lo construyen', overrides: { '/docs:intro': 'Hecho por agentes' } },
      [h('For developers')]: { default: 'Para desarrolladores', overrides: { '/docs:_meta': 'Documentación' } },
    }
    const es = mergeTranslations(site(['/docs']), table)
    expect(texts(pageAt(es, '/docs').sections[0].content)).toEqual(['Hecho por agentes', 'For developers'])
    expect(pageAt(es, '/docs').title).toBe('Documentación')
    expect(texts(pageAt(es, '/docs/setup').sections[0].content)).toEqual(['For developers'])
    expect(texts(pageAt(es, '/').sections[0].content)).toEqual(['Los agentes lo construyen', 'Para desarrolladores'])
  })

  it('translates the layout on every page: it is the site’s own', () => {
    const es = mergeTranslations(site(['/docs']), ES)
    expect(texts(es.layouts.default.header.sections[0].content)).toEqual(['Para desarrolladores'])
  })
})

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const quiet = async (fn) => {
  const saved = [console.log, console.warn]
  console.log = console.warn = () => {}
  try {
    return await fn()
  } finally {
    ;[console.log, console.warn] = saved
  }
}

const SITE = 'name: Site\ndefaultLanguage: en\nlanguages: [en, es]\nfoundation: "@acme/fnd@1.0.0"\nindex: home\ni18n:\n  exclude: [/docs]\n'
const FILES = {
  'layout/header.md': '---\ntype: Header\n---\n\n[For developers](/docs)\n',
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/1-hero.md': '---\ntype: Hero\n---\n\n# Agents build it\n\nFor developers\n',
  'pages/docs/page.yml': 'title: For developers\n',
  'pages/docs/1-intro.md': '---\ntype: Doc\n---\n\n# Agents build it\n\nFor developers\n',
}

function project(es, site = SITE) {
  const root = mkdtempSync(join(tmpdir(), 'i18n-exclude-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries({ 'site.yml': site, ...FILES, 'locales/es.json': JSON.stringify(es, null, 2) + '\n' })) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

const pageOf = (document, route) => document.pages.find((page) => buildRouteOf(page, '/', 'en') === route)

describe('a push', () => {
  it('⭐ sends a section on such a page in its source alone, and its title too', async () => {
    const document = await quiet(() => siteProjectToDocument(project(ES)))
    const docs = pageOf(document, '/docs')
    expect(Object.keys(docs.page_sections[0].content)).toEqual(['en'])
    expect(docs.title).toEqual({ en: 'For developers' })
    expect(texts(pageOf(document, '/').page_sections[0].content.es)).toEqual(['Los agentes lo construyen', 'Para desarrolladores'])
    expect(texts(document.layout_sections[0].content.es)).toEqual(['Para desarrolladores'])
  })

  it('CONTROL — with nothing excluded, it sends the site’s translation there', async () => {
    const document = await quiet(() => siteProjectToDocument(project(ES, SITE.replace('i18n:\n  exclude: [/docs]\n', ''))))
    expect(texts(pageOf(document, '/docs').page_sections[0].content.es)).toEqual(['Los agentes lo construyen', 'Para desarrolladores'])
  })

  it('sends a translation written for its place', async () => {
    const es = { ...ES, [h('Agents build it')]: { default: 'Los agentes lo construyen', overrides: { '/docs:intro': 'Hecho por agentes' } }, [h('For developers')]: { default: 'Para desarrolladores', overrides: { '/docs:_meta': 'Documentación' } } }
    const document = await quiet(() => siteProjectToDocument(project(es)))
    const docs = pageOf(document, '/docs')
    expect(texts(docs.page_sections[0].content.es)).toEqual(['Hecho por agentes', 'For developers'])
    expect(docs.title).toEqual({ en: 'For developers', es: 'Documentación' })
  })
})

// Push the project, let `edit` change what the backend holds, and pull it back into the same copy.
async function roundTrip(root, edit = () => {}) {
  const before = readFileSync(join(root, 'locales/es.json'), 'utf8')
  const document = JSON.parse(JSON.stringify(await quiet(() => siteProjectToDocument(root))))
  edit(document)
  await quiet(() => siteContentDocumentToProject({ document, siteRoot: root, prune: true }))
  const after = readFileSync(join(root, 'locales/es.json'), 'utf8')
  return { before, after, es: JSON.parse(after) }
}

describe('a pull', () => {
  it('into the copy that pushed changes nothing', async () => {
    const { before, after } = await roundTrip(project(ES))
    expect(after).toBe(before)
  })

  it('⭐ brings what an author translated on such a page back as an override for its place, which the next push sends there alone', async () => {
    const root = project(ES)
    const { es } = await roundTrip(root, (document) => {
      const intro = pageOf(document, '/docs').page_sections[0]
      const translated = JSON.parse(JSON.stringify(intro.content.en))
      translated.content[0].content = [{ type: 'text', text: 'Hecho por agentes' }]
      intro.content.es = translated
    })
    expect(es[h('Agents build it')]).toEqual({ default: 'Los agentes lo construyen', overrides: { '/docs:intro': 'Hecho por agentes' } })
    // The row the author left in English is in English whatever the site's translation says.
    expect(es[h('For developers')]).toBe('Para desarrolladores')

    const again = await quiet(() => siteProjectToDocument(root))
    expect(texts(pageOf(again, '/docs').page_sections[0].content.es)).toEqual(['Hecho por agentes', 'For developers'])
    expect(texts(pageOf(again, '/').page_sections[0].content.es)).toEqual(['Los agentes lo construyen', 'Para desarrolladores'])
  })

  it('brings a translation of words only such a page has as an override with no default, and an author’s title for it too', async () => {
    const root = project({})
    const { es } = await roundTrip(root, (document) => {
      const docs = pageOf(document, '/docs')
      docs.title = { ...docs.title, es: 'Documentación' }
      const intro = docs.page_sections[0]
      const translated = JSON.parse(JSON.stringify(intro.content.en))
      translated.content[0].content = [{ type: 'text', text: 'Hecho por agentes' }]
      intro.content.es = translated
    })
    expect(es[h('Agents build it')]).toEqual({ overrides: { '/docs:intro': 'Hecho por agentes' } })
    expect(es[h('For developers')]).toEqual({ overrides: { '/docs:_meta': 'Documentación' } })

    const again = await quiet(() => siteProjectToDocument(root))
    expect(pageOf(again, '/docs').title).toEqual({ en: 'For developers', es: 'Documentación' })
    expect(Object.keys(pageOf(again, '/').page_sections[0].content)).toEqual(['en'])
  })

  it('ends an override for such a place when the author clears it, and keeps the rest of the entry', async () => {
    const root = project({ ...ES, [h('Agents build it')]: { default: 'Los agentes lo construyen', overrides: { '/docs:intro': 'Hecho por agentes' } } })
    const { es } = await roundTrip(root, (document) => {
      const intro = pageOf(document, '/docs').page_sections[0]
      intro.content.es = JSON.parse(JSON.stringify(intro.content.en))
    })
    expect(es[h('Agents build it')]).toBe('Los agentes lo construyen')
    expect(es[h('For developers')]).toBe('Para desarrolladores')
  })
})

describe('uniweb i18n audit', () => {
  // The manifest holds the site's own strings alone: extraction takes none from an excluded page.
  function locales(es) {
    const root = mkdtempSync(join(tmpdir(), 'i18n-exclude-audit-'))
    dirs.push(root)
    mkdirSync(join(root, 'locales'))
    writeFileSync(join(root, 'locales/manifest.json'), JSON.stringify({ version: '1.0', defaultLocale: 'en', units: { [h('Agents build it')]: { source: 'Agents build it' } } }))
    writeFileSync(join(root, 'locales/es.json'), JSON.stringify(es))
    return join(root, 'locales')
  }
  const ON_DOCS = { overrides: { '/docs:intro': 'Hecho por agentes' } }

  it('⭐ lists a translation written for a place on such a page apart, never as stale', async () => {
    const result = await auditLocale(locales({ [h('Agents build it')]: 'Los agentes', [h('Only in the docs')]: ON_DOCS, [h('Gone')]: 'Ido' }), 'es', { exclude: ['/docs'] })
    expect(result.excluded.map((entry) => entry.hash)).toEqual([h('Only in the docs')])
    expect(result.stale.map((entry) => entry.hash)).toEqual([h('Gone')])
  })

  it('CONTROL — with nothing excluded, the same entry is stale', async () => {
    const result = await auditLocale(locales({ [h('Only in the docs')]: ON_DOCS }), 'es')
    expect(result.stale.map((entry) => entry.hash)).toEqual([h('Only in the docs')])
  })
})
