/**
 * ⭐ ONE TEXT IN TWO FORMS — a plain heading in one place, a link in another — IS ONE UNIT, AND AN
 * UNTOUCHED SEEDED LOCALE RENDERS IT AS THE SOURCE DOES.
 *
 * A unit is keyed by its plain text (`hash.js`), so `Faculty of Science` in a header and
 * `[Faculty of Science](/)` in a list share one value. Extraction says when a unit's places disagree
 * on markup (`markupVaries`), and `uniweb i18n init` starts such a unit with its plain words: the
 * heading takes them as they are, and the link takes them as its label. ⛔ Until 2026-10-16 init
 * seeded the link everywhere, so the header's heading became a link — and the parser, which reads a
 * heading made only of a link as a link, left the header without its title.
 *
 * A value is taken as written — a link a translator or an author writes is kept, also where the
 * source has none, so a pull's file and the next push agree. ⛔ @uniweb/build 1.3.6 dropped such a
 * link instead, and lost an author's link on the push after a pull; reverted the same day.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSiteData } from '../src/site/index.js'
import { buildLocalizedContent, extractManifest } from '../src/i18n/index.js'
import { translatedInline, toPlainText } from '../src/i18n/merge.js'
import { computeHash as h } from '../src/i18n/hash.js'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'i18n-shared-unit-'))
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
const link = (href) => ({ type: 'link', attrs: { href, title: null } })
const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t })

describe('translatedInline — a value is taken as written', () => {
  it('⭐ a link a translator writes is kept, also where the source has none — an author may add one in the app', () => {
    expect(translatedInline([text('See our guide')], 'Voir [notre guide](/fr/guide)')).toEqual([text('Voir '), text('notre guide', [link('/fr/guide')])])
  })

  it('the element that has the link takes it as written, re-targeted or not', () => {
    expect(translatedInline([text('Faculty of Science', [link('/')])], '[Faculté des sciences](/fr/)')).toEqual([
      text('Faculté des sciences', [link('/fr/')]),
    ])
  })

  it('a button translated by its label alone keeps its button — a button is a link drawn as one', () => {
    const button = { type: 'button', attrs: { href: '/sign-in', title: null, variant: 'primary' } }
    expect(translatedInline([text('Sign in', [button])], 'Se connecter')).toEqual([text('Se connecter', [button])])
  })
})

describe('toPlainText — a plain-text place takes a value’s words', () => {
  it('blocks stay apart', () => {
    expect(toPlainText('Lun–Ven 9h–17h\n\n*Fermé les jours fériés*')).toBe('Lun–Ven 9h–17h Fermé les jours fériés')
    expect(toPlainText('[Se connecter](/sign-in)')).toBe('Se connecter')
  })
})

// A header that says a text as a heading, a page that says it as a link; a page titled with a text a
// nav link says; a data block whose label is that text too.
function site() {
  const root = tmp()
  write(root, {
    'site.yml': 'name: Site\ndefaultLanguage: en\nlanguages: [en, fr]\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n',
    'layout/header.md': '---\ntype: Header\n---\n\n# Faculty of Science\n\n[Sign in](/sign-in)\n',
    'pages/home/page.yml': 'title: Home\n',
    'pages/home/1-directory.md':
      '---\ntype: Directory\n---\n\n## People\n\n[Faculty of Science](/)\n\n```yaml:menu\nlabel: Sign in\nnote: Use **your** account\n```\n',
    'pages/sign-in/page.yml': 'title: Sign in\n',
    'pages/sign-in/1-form.md': '---\ntype: SignIn\n---\n\n# Welcome back\n\nUse **your** account\n',
  })
  return root
}

// What a visitor reads in each language: every element as its text with its links, titles, and the
// values of data blocks.
function inline(nodes) {
  return (nodes || [])
    .map((n) => {
      const l = n.marks?.find((m) => m.type === 'link')
      return n.type === 'text' ? (l ? `[${n.text}](${l.attrs.href})` : n.text) : `<${n.type}>`
    })
    .join('')
}
function blocks(doc) {
  return (doc?.content || []).map((b) => (b.type === 'dataBlock' ? `data:${JSON.stringify(b.attrs?.data)}` : `${b.type}: ${inline(b.content)}`))
}
function view(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'))
  return {
    header: (c.layouts?.default?.header?.sections || []).flatMap((s) => blocks(s.content)),
    pages: Object.fromEntries((c.pages || []).map((p) => [p.route, { title: p.title, blocks: (p.sections || []).flatMap((s) => blocks(s.content)) }])),
  }
}
async function rendered(siteRoot) {
  const root = join(tmp(), 'site')
  cpSync(siteRoot, root, { recursive: true })
  await quiet(async () => {
    await buildSiteData({ siteRoot: root, distDir: join(root, 'dist'), foundationPath: null, assets: { process: false } })
    await buildLocalizedContent(root, { locales: ['fr'], localesDir: 'locales', generateSearchIndexes: false })
  })
  return { en: view(join(root, 'dist/site-content.json')), fr: view(join(root, 'dist/fr/site-content.json')) }
}

// `uniweb i18n init fr`, by its rule (cli `starterValue`): a unit whose places disagree on markup
// starts with its words; any other with its markup, else its words.
const starter = (unit) => (unit.markupVaries ? unit.source : unit.markup || unit.source)
async function seeded(root) {
  const built = join(tmp(), 'site')
  cpSync(root, built, { recursive: true })
  await quiet(() => buildSiteData({ siteRoot: built, distDir: join(built, 'dist'), foundationPath: null, assets: { process: false } }))
  const content = JSON.parse(readFileSync(join(built, 'dist/site-content.json'), 'utf8'))
  const { manifest } = await quiet(() => extractManifest(built, content))
  write(root, { 'locales/fr.json': Object.fromEntries(Object.entries(manifest.units).map(([hash, u]) => [hash, starter(u)])) })
  return manifest
}

describe('a locale seeded by `uniweb i18n init` and left untouched', () => {
  it('the manifest says when a text’s places disagree on markup — and keeps the markup as the prompt', async () => {
    const manifest = await seeded(site())
    expect(manifest.units[h('Faculty of Science')]).toMatchObject({ markup: '[Faculty of Science](/)', markupVaries: true })
    expect(manifest.units[h('Sign in')]).toMatchObject({ markup: '[Sign in](/sign-in)', markupVaries: true })
    expect(manifest.units[h('Use your account')]).toMatchObject({ markup: 'Use **your** account' })
    expect(manifest.units[h('Use your account')].markupVaries).toBeUndefined()
  })

  it('⭐ renders every page, title and data block as the source does', async () => {
    const src = site()
    await seeded(src)
    const { en, fr } = await rendered(src)
    expect(fr).toEqual(en)
    expect(fr.header[0]).toBe('heading: Faculty of Science')
  })

  it('a push sends what the build renders, and a pull of it renders the same and leaves the file as it was', async () => {
    const src = site()
    await seeded(src)
    const before = await rendered(src)
    const doc = await quiet(() => siteProjectToDocument(src))
    expect(doc.pages.find((p) => p.title?.en === 'Sign in').title).toEqual({ en: 'Sign in', fr: 'Sign in' })
    // What a host serves in French: the French document, or the source where nothing was translated.
    const header = doc.layout_sections.find((s) => s.stable_id === 'header').content
    expect(blocks(header.fr ?? header.en)[0]).toBe('heading: Faculty of Science')
    const wire = JSON.stringify(doc)
    const file = readFileSync(join(src, 'locales/fr.json'), 'utf8')
    const copy = join(tmp(), 'site')
    cpSync(src, copy, { recursive: true })
    await quiet(() => siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: copy, prune: true }))
    expect(readFileSync(join(copy, 'locales/fr.json'), 'utf8'), 'the author’s translations').toBe(file)
    expect(await rendered(copy), 'the author’s copy').toEqual(before)
    const clone = tmp()
    await quiet(() => siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: clone, prune: true }))
    expect(await rendered(clone), 'a clone').toEqual(before)
  })
})

describe('a translation written with a link, for a text that is also a page’s title', () => {
  it('the title takes its words on both lanes — the build’s and a push’s', async () => {
    const src = site()
    write(src, { 'locales/fr.json': { [h('Sign in')]: '[Se connecter](/sign-in)' } })
    const { fr } = await rendered(src)
    expect(fr.pages['/sign-in'].title).toBe('Se connecter')
    const doc = await quiet(() => siteProjectToDocument(src))
    expect(doc.pages.find((p) => p.title?.en === 'Sign in').title).toEqual({ en: 'Sign in', fr: 'Se connecter' })
  })
})
