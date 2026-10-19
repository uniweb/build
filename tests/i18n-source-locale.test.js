/**
 * ⭐ A SITE WRITTEN IN ANOTHER LANGUAGE THAN ENGLISH SURVIVES SYNC — its pages, its records and the
 * paths its units are keyed by, in the language the site is written in (`uwx/source-locale.js`).
 *
 * ⛔ Until 2026-10-16 the page push asked the site for its language and nothing else did: the record
 * push and every pull assumed `en`. A French site with an English translation came back from a pull
 * in English — its French filed as a translation of the English — a French-only clone came back with
 * empty sections, and records were pushed with their French labelled `en` and their English left out.
 * Every site measured before then was written in English, which is why nothing failed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  siteProjectToDocument,
  siteContentDocumentToProject,
  collectSiteUnits,
  emitSyncPackages,
  readZip,
  recordsToProject,
} from '../src/uwx/index.js'
import { siteSourceLocale, documentSourceLocale } from '../src/uwx/source-locale.js'
import { buildSiteData } from '../src/site/index.js'
import { buildLocalizedContent } from '../src/i18n/index.js'
import { resolveLocaleList } from '../src/i18n/locales.js'
import { computeHash as h } from '../src/i18n/hash.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'i18n-source-locale-'))
  dirs.push(d)
  return d
}
const write = (root, files) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
  }
}
const quiet = async (fn) => {
  const saved = [console.log, console.warn]
  console.log = console.warn = () => {}
  try {
    return await fn()
  } finally {
    ;[console.log, console.warn] = saved
  }
}

// What a visitor reads in each of the site's languages — titles and text, through the link build's
// own i18n pipeline — keyed by language, the site's own at the root.
function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out))
  else if (node && typeof node === 'object') {
    if (node.type === 'text') out.push(node.text)
    for (const [k, v] of Object.entries(node)) if (k !== 'attrs' && v && typeof v === 'object') texts(v, out)
  }
  return out
}
function summary(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'))
  const sectionText = (p) => (p.sections || []).map((s) => texts(s.content).join(' | ')).join(' || ')
  return {
    pages: Object.fromEntries((c.pages || []).map((p) => [p.route, { title: p.title ?? null, text: sectionText(p) }])),
    layouts: Object.fromEntries(Object.entries(c.layouts || {}).flatMap(([n, areas]) => Object.entries(areas || {}).map(([a, p]) => [`${n}/${a}`, sectionText(p)]))),
  }
}
async function rendered(siteRoot) {
  const root = join(tmp(), 'site')
  cpSync(siteRoot, root, { recursive: true })
  const config = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8')) || {}
  const locales = resolveLocaleList(config.languages, join(root, 'locales'))
  await quiet(async () => {
    await buildSiteData({ siteRoot: root, distDir: join(root, 'dist'), foundationPath: null })
    if (locales.length) await buildLocalizedContent(root, { locales, localesDir: 'locales', generateSearchIndexes: false })
  })
  const own = siteSourceLocale(root)
  const out = { [own]: summary(join(root, 'dist', 'site-content.json')) }
  for (const l of locales) if (l !== own) out[l] = summary(join(root, 'dist', l, 'site-content.json'))
  return out
}

// A push, then a pull into the author's copy and into an empty directory, as the CLI makes them:
// neither names a language.
async function roundTrip(src) {
  const wire = JSON.stringify(await quiet(() => siteProjectToDocument(src)))
  const copy = join(tmp(), 'site')
  cpSync(src, copy, { recursive: true })
  await quiet(() => siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: copy, prune: true }))
  const clone = tmp()
  await quiet(() => siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: clone, prune: true }))
  return { copy, clone }
}

const FR = { home: 'Accueil', welcome: 'Bienvenue', pandas: 'Nous protégeons les pandas.', rights: 'Tous droits réservés.' }
const EN = { home: 'Home', welcome: 'Welcome', pandas: 'We protect pandas.', rights: 'All rights reserved.' }

function frenchSite({ english = true } = {}) {
  const root = tmp()
  write(root, {
    'site.yml': `name: Site\ndefaultLanguage: fr\nlanguages: [${english ? 'fr, en' : 'fr'}]\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n`,
    'pages/home/page.yml': `title: ${FR.home}\n`,
    'pages/home/1-hero.md': `---\ntype: Hero\n---\n\n# ${FR.welcome}\n\n${FR.pandas}\n`,
    'layout/footer.md': `---\ntype: Footer\n---\n\n${FR.rights}\n`,
    ...(english ? { 'locales/en.json': Object.fromEntries(Object.keys(FR).map((k) => [h(FR[k]), EN[k]])) } : {}),
  })
  return root
}

describe('the language a site is written in', () => {
  it('a document says it in `settings`: its default language, else the first of its languages, else en', () => {
    expect(documentSourceLocale({ settings: { default_language: 'fr', languages: ['en', 'fr'] } })).toBe('fr')
    expect(documentSourceLocale({ settings: { languages: ['es', 'en'] } })).toBe('es')
    expect(documentSourceLocale({ settings: {} })).toBe('en')
    expect(documentSourceLocale(null)).toBe('en')
  })

  it('a site says it in `site.yml`, by the same rule', () => {
    const fr = tmp()
    write(fr, { 'site.yml': 'name: S\nlanguages: [fr, en]\n' })
    expect(siteSourceLocale(fr)).toBe('fr')
    expect(siteSourceLocale(tmp())).toBe('en') // no site.yml
  })
})

describe('a French site through sync', () => {
  it('⭐ with an English translation, the author’s copy and a clone render both languages as the site does', async () => {
    const src = frenchSite()
    const before = await rendered(src)
    expect(before.fr.pages['/'].text).toContain(FR.pandas) // the source is French
    expect(before.en.pages['/'].text).toContain(EN.pandas)
    const { copy, clone } = await roundTrip(src)
    expect(await rendered(copy), 'the author’s copy after a pull').toEqual(before)
    expect(await rendered(clone), 'a clone').toEqual(before)
    // The files stay French, and English stays the translation.
    expect(readFileSync(join(clone, 'pages/home/hero.md'), 'utf8')).toContain(FR.pandas)
    expect(existsSync(join(clone, 'locales/fr.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(clone, 'locales/en.json'), 'utf8'))[h(FR.pandas)]).toBe(EN.pandas)
  })

  it('French only, a clone keeps every section’s text — and no French is filed as a translation', async () => {
    const src = frenchSite({ english: false })
    const before = await rendered(src)
    const { copy, clone } = await roundTrip(src)
    expect(await rendered(clone), 'a clone').toEqual(before)
    expect(await rendered(copy), 'the author’s copy after a pull').toEqual(before)
    for (const dir of [copy, clone]) expect(existsSync(join(dir, 'locales/freeform'))).toBe(false)
  })

  it('a document’s units are keyed by the French folder, where the pull writes the page', async () => {
    const src = tmp()
    write(src, {
      'site.yml': 'name: Site\ndefaultLanguage: fr\nlanguages: [fr, en]\nfoundation: "@acme/fnd@1.0.0"\nindex: accueil\n',
      'pages/accueil/page.yml': 'title: Accueil\n',
      'pages/apropos/page.yml': 'title: À propos\nslug:\n  en: about\n',
      'pages/apropos/1-intro.md': '---\ntype: Section\n---\n\nNotre histoire.\n',
    })
    const doc = await quiet(() => siteProjectToDocument(src))
    expect([...collectSiteUnits(doc).keys()]).toContain('pages/apropos/page.yml')
    const clone = tmp()
    await quiet(() => siteContentDocumentToProject({ document: doc, siteRoot: clone, prune: true }))
    expect(existsSync(join(clone, 'pages/apropos/page.yml'))).toBe(true)
    expect(existsSync(join(clone, 'pages/about'))).toBe(false)
  })
})

describe('the records of a French site', () => {
  const BACKEND = 'http://backend.test'
  const REVIEW = validateAndNormalizeSchema({ name: 'review', sections: { brief: { brief: true, fields: { headline: { type: 'string' } } } } }, '@/review')
  const DECLARATION = toDataSchemaDeclaration(REVIEW, { name: '@acme/review' })
  const HEADLINE = 'Une pièce pour l’esprit'
  const TRANSLATED = 'A play for the mind'

  function site() {
    const root = tmp()
    write(root, {
      'site/site.yml': 'name: T\ndefaultLanguage: fr\nlanguages: [fr, en]\nfoundation: fnd\n',
      'site/package.json': { name: 'site', dependencies: { fnd: 'file:../fdn' } },
      'site/queries.yml': "reviews:\n  schema: '@/review'\n",
      'site/pages/home/page.yml': 'title: Accueil\n',
      'site/records/review/manfred.md': `---\nheadline: ${HEADLINE}\n---\n`,
      'site/locales/records/en.json': { [h(HEADLINE)]: TRANSLATED },
      'fdn/package.json': { name: 'fnd', type: 'module', main: './_entry.generated.js' },
      'fdn/main.js': "export default { name: '@acme/fnd' }\n",
      'fdn/dist/meta/schema.json': { _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' }, dataSchemas: { '@/review': REVIEW } },
    })
    return join(root, 'site')
  }

  async function push(siteRoot) {
    const pkg = await quiet(() => emitSyncPackages(siteRoot, { backend: BACKEND }))
    expect(pkg.refusals).toEqual([])
    return [...readZip(pkg.records.buffer)]
      .filter(([name]) => name.startsWith('entities/'))
      .map(([, buf]) => JSON.parse(buf.toString('utf8')))
      .filter((d) => d.$schema === '@acme/review')
  }

  it('⭐ a push sends them in French, with their English translation', async () => {
    const [review] = await push(site())
    expect(review.brief.headline).toEqual({ fr: HEADLINE, en: TRANSLATED })
  })

  it('a clone gets the French record back, and its English translation beside it', async () => {
    const entities = await push(site())
    const clone = tmp()
    // What the pull of the site's content writes first: the site's languages.
    writeFileSync(join(clone, 'site.yml'), 'name: T\ndefaultLanguage: fr\nlanguages: [fr, en]\n')
    const recordDocs = entities.map((e) => ({ ...e, $uuid: `U-${e.$id.split('/').pop()}` }))
    const report = recordsToProject({
      folderDoc: { contents: recordDocs.map((d) => ({ kind: 'ref', name: d.$uuid.slice(2), entry: { schema: '@acme/review', entity: d.$uuid } })) },
      recordDocs,
      siteRoot: clone,
      opts: { backend: BACKEND, resolveDeclaration: () => DECLARATION, scope: '@acme' },
    })
    expect(report.skipped).toEqual([])
    const file = readdirSync(join(clone, 'records/review')).find((n) => n.startsWith('manfred.'))
    expect(readFileSync(join(clone, 'records/review', file), 'utf8')).toContain(HEADLINE)
    expect(JSON.parse(readFileSync(join(clone, 'locales/records/en.json'), 'utf8'))).toEqual({ [h(HEADLINE)]: TRANSLATED })
  })
})
