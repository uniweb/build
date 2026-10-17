/**
 * ⭐ ONE TEXT IN TWO FORMS — a plain heading in one place, a link in another — IS ONE UNIT, AND ITS
 * MARKUP BELONGS TO THE PLACE THAT HAS IT.
 *
 * A unit is keyed by its plain text (`hash.js`), so `Faculty of Science` in a header and
 * `[Faculty of Science](/)` in a list share a translation, and `uniweb i18n init` seeds it with the
 * markup of the occurrence that carries some. ⛔ Until 2026-10-16 every place took that value as
 * written: an untouched seeded locale turned the header's heading into a link (and the parser, which
 * reads a heading made only of a link as a link, left the header without its title), a data block's
 * label rendered `[Sign in](/sign-in)`, and a push sent a page's title as that markdown, which the
 * build had always rendered as text.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSiteData } from '../src/site/index.js'
import { buildLocalizedContent, extractManifest } from '../src/i18n/index.js'
import { translatedInline } from '../src/i18n/merge.js'
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

describe('translatedInline — a link is the source’s to have', () => {
  it('⭐ a value that writes a link gives a plain element its words alone', () => {
    expect(translatedInline([text('Faculty of Science')], '[Faculté des sciences](/)')).toEqual([text('Faculté des sciences')])
  })

  it('the element that has the link takes it as written, re-targeted or not', () => {
    expect(translatedInline([text('Faculty of Science', [link('/')])], '[Faculté des sciences](/fr/)')).toEqual([
      text('Faculté des sciences', [link('/fr/')]),
    ])
  })

  it('a plain element keeps the emphasis a translator writes, and its words read as one run', () => {
    expect(translatedInline([text('Read the guide')], 'Lisez le [**guide**](/g) ici')).toEqual([
      text('Lisez le '),
      text('guide', [{ type: 'bold' }]),
      text(' ici'),
    ])
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
    .map((n) => (n.type === 'text' ? (n.marks?.find((m) => m.type === 'link') ? `[${n.text}](${n.marks.find((m) => m.type === 'link').attrs.href})` : n.text) : `<${n.type}>`))
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

// `uniweb i18n init fr`: each unit seeded with its markup, else its text (cli `starterValue`).
async function seeded(root) {
  const built = join(tmp(), 'site')
  cpSync(root, built, { recursive: true })
  await quiet(() => buildSiteData({ siteRoot: built, distDir: join(built, 'dist'), foundationPath: null, assets: { process: false } }))
  const content = JSON.parse(readFileSync(join(built, 'dist/site-content.json'), 'utf8'))
  const { manifest } = await quiet(() => extractManifest(built, content))
  write(root, { 'locales/fr.json': Object.fromEntries(Object.entries(manifest.units).map(([hash, u]) => [hash, u.markup || u.source])) })
  return manifest
}

describe('a locale seeded by `uniweb i18n init` and left untouched', () => {
  it('the seed carries the link to every occurrence of the text — the case this is about', async () => {
    const src = site()
    const manifest = await seeded(src)
    expect(manifest.units[h('Faculty of Science')].markup).toBe('[Faculty of Science](/)')
    expect(manifest.units[h('Sign in')].markup).toBe('[Sign in](/sign-in)')
  })

  it('⭐ renders every page, title and data block as the source does', async () => {
    const src = site()
    await seeded(src)
    const { en, fr } = await rendered(src)
    expect(fr).toEqual(en)
    expect(fr.header[0]).toBe('heading: Faculty of Science')
    expect(fr.pages['/sign-in'].title).toBe('Sign in')
  })

  it('a push sends it as the build renders it — the title as text, the heading without the link', async () => {
    const src = site()
    await seeded(src)
    const doc = await quiet(() => siteProjectToDocument(src))
    const signIn = doc.pages.find((p) => p.title?.en === 'Sign in')
    expect(signIn.title).toEqual({ en: 'Sign in', fr: 'Sign in' })
    const header = doc.layout_sections.find((s) => s.stable_id === 'header')
    expect(blocks(header.content.fr)[0]).toBe('heading: Faculty of Science')
    const directory = doc.pages.find((p) => p.title?.en === 'Home').page_sections[0]
    expect(blocks(directory.content.fr)).toEqual(blocks(directory.content.en))
  })

  it('and a pull of that push, into the author’s copy and into a clone, renders the same', async () => {
    const src = site()
    await seeded(src)
    const before = await rendered(src)
    const wire = JSON.stringify(await quiet(() => siteProjectToDocument(src)))
    const copy = join(tmp(), 'site')
    cpSync(src, copy, { recursive: true })
    await quiet(() => siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: copy, prune: true }))
    const clone = tmp()
    await quiet(() => siteContentDocumentToProject({ document: JSON.parse(wire), siteRoot: clone, prune: true }))
    expect(await rendered(copy), 'the author’s copy').toEqual(before)
    expect(await rendered(clone), 'a clone').toEqual(before)
  })
})

describe('a data block’s strings', () => {
  it('a string written as text takes a translation’s words; one written with markdown keeps it as written', async () => {
    const src = site()
    write(src, { 'locales/fr.json': { [h('Sign in')]: '[Connexion](/sign-in)', [h('Use **your** account')]: 'Utilisez **votre** compte' } })
    const { fr } = await rendered(src)
    expect(fr.pages['/'].blocks).toContain('data:{"label":"Connexion","note":"Utilisez **votre** compte"}')
    expect(fr.pages['/sign-in'].title).toBe('Connexion')
  })
})
