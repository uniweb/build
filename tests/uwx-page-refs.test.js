/**
 * ⭐ A LINK TO A PAGE IS A PATH IN FILES AND AN ID IN THE STORE (2026-10-29).
 *
 * An editor links a page by its stable id, and a pull wrote that id into the file: an author
 * reading `[AI](page:3f58142d)` could not tell where it went. A pull writes a stored link as the
 * page's path now, and a push stores a file's path by the page's id when the page has one, so the
 * store keeps the form that survives a rename in an editor (`page-refs.js`).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip, siteContentDocumentToProject } from '../src/uwx/index.js'
import { isCodeId, pageRefIndex, storedPageRef, writtenPageRef } from '../src/uwx/page-refs.js'
import { computeHash } from '../src/i18n/hash.js'

const BACKEND = 'http://localhost:8080'
let ROOT, SITE
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const read = (rel) => readFileSync(join(SITE, rel), 'utf8')
const sent = (pkg) => JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
const hrefsOf = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (typeof node.attrs?.href === 'string') out.push(node.attrs.href)
  for (const mark of node.marks || []) if (mark?.attrs?.href) out.push(mark.attrs.href)
  for (const child of node.content || []) hrefsOf(child, out)
  return out
}
const header = (doc) => doc.layout_sections.find((s) => JSON.stringify(s.content).includes('page:'))
const pageNamed = (doc, slug) => doc.pages.find((p) => Object.values(p.slug || {}).includes(slug))

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-page-refs-'))
  SITE = join(ROOT, 'site')
  mkdirSync(join(ROOT, 'foundation', 'dist', 'meta'), { recursive: true })
  writeFileSync(
    join(ROOT, 'foundation', 'dist', 'meta', 'schema.json'),
    JSON.stringify({ _self: { name: '@acme/marketing', version: '1', role: 'foundation' } })
  )
  w('site.yml', ['name: Acme', 'foundation: "@acme/marketing"', 'index: home', ''].join('\n'))
  w('package.json', JSON.stringify({ name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } }))
  w('pages/home/page.yml', 'id: home\n')
  w('pages/home/1-hero.md', '---\ntype: Hero\nid: hero\nlink: page:ai\n---\n\n# Hi\n\nWrite `page:ai` to link the AI page.\n')
  // The AI page has the id an editor minted for it; the contact page has none.
  w('pages/ai/page.yml', 'id: 3f58142d\n')
  w('pages/ai/1-intro.md', '---\ntype: Hero\nid: intro\n---\n\n# AI\n')
  w('pages/contact/1-intro.md', '---\ntype: Hero\nid: intro\n---\n\n# Contact\n')
  w('pages/old/page.yml', 'redirect: page:ai\n')
  w('layout/header.md', '---\ntype: Header\n---\n\n[AI](page:ai)\n\n[Contact](page:contact)\n\n[Home](page:home)\n')
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe("the rule — the runtime's: a page's id, else its route; only a code is translated", () => {
  const index = pageRefIndex([
    { id: 'home', route: '/', dynamic: false }, // a word an author chose
    { id: '3f58142d', route: '/ai', dynamic: false }, // a code an editor minted
    { id: null, route: '/contact', dynamic: false },
    { id: 'b4c5d6e7', route: '/x', dynamic: false },
    { id: 'x', route: '/y', dynamic: false }, // a word that claims the path `x`
    { id: '9e8d7c6b', route: '/news/:slug', dynamic: true },
    { id: 'a1b2c3d4', route: '/', dynamic: false }, // never reached: the homepage's route is taken
  ])

  it('tells a code from a word', () => {
    for (const id of ['3f58142d', 'a1b2c3d4', '12345678']) expect(isCodeId(id)).toBe(true)
    for (const id of ['home', 'installation', 'v1-guide', 'cafebabe', 'abc123', null]) expect(isCodeId(id)).toBe(false)
  })

  it("a push stores a path by its page's code, and keeps a word, a path to a word's page and one with none", () => {
    expect(storedPageRef('page:ai', index)).toBe('page:3f58142d')
    expect(storedPageRef('page:/ai/#team', index)).toBe('page:3f58142d#team')
    expect(storedPageRef('page:3f58142d', index)).toBe('page:3f58142d')
    expect(storedPageRef('page:home#visit', index)).toBe('page:home#visit')
    expect(storedPageRef('page:/', index)).toBe('page:/')
    expect(storedPageRef('page:contact', index)).toBe('page:contact')
    expect(storedPageRef('page:nowhere', index)).toBe('page:nowhere')
    expect(storedPageRef('/ai', index)).toBe('/ai')
  })

  it("a pull writes a code as its page's path, and anything else as stored", () => {
    expect(writtenPageRef('page:3f58142d', index)).toBe('page:ai')
    expect(writtenPageRef('page:3f58142d#team', index)).toBe('page:ai#team')
    expect(writtenPageRef('page:home#visit', index)).toBe('page:home#visit')
    expect(writtenPageRef('page:ai', index)).toBe('page:ai')
    expect(writtenPageRef('page:contact', index)).toBe('page:contact')
  })

  it('keeps the code where its path would name another page, or the page is parametric', () => {
    expect(writtenPageRef('page:b4c5d6e7', index)).toBe('page:b4c5d6e7')
    expect(writtenPageRef('page:9e8d7c6b', index)).toBe('page:9e8d7c6b')
    expect(writtenPageRef('page:nowhere', index)).toBe('page:nowhere')
  })
})

describe('a push stores a page link by the page\'s id', () => {
  it('in a layout\'s links, a section\'s params and a page\'s redirect, never in text', async () => {
    const doc = sent(await emitSyncPackages(SITE))
    expect(hrefsOf(Object.values(header(doc).content)[0])).toEqual(['page:3f58142d', 'page:contact', 'page:home'])
    const hero = pageNamed(doc, 'home').page_sections[0]
    expect(hero.params.link).toBe('page:3f58142d')
    expect(JSON.stringify(hero.content)).toContain('"text":"page:ai"')
    expect(pageNamed(doc, 'old').redirect).toBe('page:3f58142d')
  })

  it('in every language a translation gives the link', async () => {
    w('site.yml', ['name: Acme', 'foundation: "@acme/marketing"', 'index: home', 'languages: [en, fr]', ''].join('\n'))
    w('locales/fr.json', JSON.stringify({ [computeHash('AI')]: 'IA' }))
    const doc = sent(await emitSyncPackages(SITE))
    expect(hrefsOf(header(doc).content.fr)).toEqual(['page:3f58142d', 'page:contact', 'page:home'])
  })
})

describe('a pull writes a stored page link as the page\'s path', () => {
  it('an id an editor wrote comes back a path, in the layout, the params and the redirect', async () => {
    const doc = sent(await emitSyncPackages(SITE))
    siteContentDocumentToProject({ document: doc, siteRoot: SITE, backend: BACKEND })
    expect(read('layout/header.md')).toContain('[AI](page:ai)')
    expect(read('layout/header.md')).toContain('[Contact](page:contact)')
    expect(read('layout/header.md')).toContain('[Home](page:home)')
    expect(read('layout/header.md')).not.toContain('3f58142d')
    expect(read('pages/home/1-hero.md')).toMatch(/link: page:ai\b/)
    expect(read('pages/old/page.yml')).toMatch(/redirect: page:ai\b/)
  })

  it("a translation's link too, so a locale file holds no id", async () => {
    w('site.yml', ['name: Acme', 'foundation: "@acme/marketing"', 'index: home', 'languages: [en, fr]', ''].join('\n'))
    w('locales/fr.json', JSON.stringify({ [computeHash('AI')]: 'IA' }))
    const doc = sent(await emitSyncPackages(SITE))
    siteContentDocumentToProject({ document: doc, siteRoot: SITE, backend: BACKEND })
    expect(read('locales/fr.json')).not.toContain('3f58142d')
  })

  it('CONTROL — a push of what the pull wrote stores the same ids again', async () => {
    const first = sent(await emitSyncPackages(SITE))
    const stored = hrefsOf(Object.values(header(first).content)[0])
    // The pull rewrites the document it is handed, as it puts asset paths back (`restoreAssetRefs`).
    siteContentDocumentToProject({ document: first, siteRoot: SITE, backend: BACKEND })
    const again = sent(await emitSyncPackages(SITE))
    expect(hrefsOf(Object.values(header(again).content)[0])).toEqual(stored)
    expect(pageNamed(again, 'old').redirect).toBe('page:3f58142d')
  })
})
