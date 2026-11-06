/**
 * ⭐ TWO FILES OF THE SAME BYTES ARE ONE STORED ASSET, AND A PULL KEEPS THE ONE THE FILES NAME.
 *
 * A backend keeps a file by its content, so two files with the same bytes are one asset: one id and
 * one served address, which is all a stored image says of its file. A pull read every reference to
 * such an asset back as the first path `sync.json` holds for it, wherever the files named the other.
 * ⛔ Measured 2026-11-05 on a docs site: its French screenshot was the English one's bytes, so the
 * French image came back as the English path, and the pull wrote the translation as its words alone.
 * Nobody had changed it, and the pull took the change as the app's.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeHash as h } from '../src/i18n/hash.js'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

const BACKEND = 'http://localhost:8080'
const ID = '2bc58fdec3fcb81d256ac2569b939be1'
const OTHER = '9f1c0e7d5b3a29180716253443526170'
const SERVED = (id) => `/assets/${id}.png`
const ALT = 'A page as sections'
const ALT_FR = 'Une page en sections'

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'uwx-same-stored-file-'))
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

const INTRO = `---\ntype: Intro\nbackground:\n  image:\n    src: /img/b.png\n---\n\n# Intro\n\n![${ALT}](/docs-media/en/x.png)\n`

function site(files = {}) {
  const root = tmp()
  write(root, {
    'site.yml': 'name: Site\ndefaultLanguage: en\nlanguages: [en, fr]\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n',
    'pages/home/page.yml': 'title: Home\n',
    'pages/home/1-intro.md': INTRO,
    'locales/fr.json': { [h('Intro')]: 'Introduction', [h(ALT)]: `![${ALT_FR}](/docs-media/fr/x.png)` },
    ...files,
  })
  return root
}

// The document as the backend keeps it: each file the map knows replaced by its served address, its id
// beside it, as a push uploads and stamps it. Two files of the same bytes are one id.
function stored(doc, assets) {
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    if (typeof node.src === 'string' && assets[node.src]) {
      const { id, ext } = assets[node.src]
      Object.assign(node, { src: SERVED(id), assetId: id, assetExt: ext })
    }
    Object.values(node).forEach(visit)
  }
  visit(doc)
  return doc
}

// The copy that pushed, pulling what it pushed, with the media map `sync.json` holds.
async function pullBack(root, assets, change = (doc) => doc) {
  const doc = await quiet(() => siteProjectToDocument(root))
  const document = change(stored(JSON.parse(JSON.stringify(doc)), assets))
  write(root, { 'sync.json': { version: 1, backends: { [BACKEND]: { assets } } } })
  const before = { intro: readFileSync(join(root, 'pages/home/1-intro.md'), 'utf8'), fr: readFileSync(join(root, 'locales/fr.json'), 'utf8') }
  const report = await quiet(() => siteContentDocumentToProject({ document, siteRoot: root, backend: BACKEND, prune: true }))
  const after = { intro: readFileSync(join(root, 'pages/home/1-intro.md'), 'utf8'), fr: JSON.parse(readFileSync(join(root, 'locales/fr.json'), 'utf8')) }
  return { before, after, report }
}

const both = (first, second, id = ID) => ({ [first]: { id, ext: 'png' }, [second]: { id, ext: 'png' } })
const assetsOf = (...maps) => Object.assign({}, ...maps)

describe('a pull, where two files of the same bytes are one stored asset', () => {
  it("⭐ keeps the translation's own file: its language's copy, not the source's", async () => {
    const root = site()
    const { after } = await pullBack(root, assetsOf(both('/docs-media/en/x.png', '/docs-media/fr/x.png'), { '/img/b.png': { id: OTHER, ext: 'png' } }))
    expect(after.fr[h(ALT)]).toBe(`![${ALT_FR}](/docs-media/fr/x.png)`)
  })

  it("⭐ keeps the section's own file in its body, whichever path the map lists first", async () => {
    const root = site()
    const { before, after } = await pullBack(root, assetsOf(both('/docs-media/fr/x.png', '/docs-media/en/x.png'), { '/img/b.png': { id: OTHER, ext: 'png' } }))
    expect(after.intro).toBe(before.intro)
    expect(after.fr[h(ALT)]).toBe(`![${ALT_FR}](/docs-media/fr/x.png)`)
  })

  it("keeps the section's own file in its frontmatter", async () => {
    const root = site()
    const { before, after } = await pullBack(root, assetsOf(both('/img/a.png', '/img/b.png', OTHER), { '/docs-media/en/x.png': { id: ID, ext: 'png' } }))
    expect(after.intro).toBe(before.intro)
  })

  it('CONTROL — a file the app changed to another asset is written, in the translation and in the body', async () => {
    const root = site()
    const assets = assetsOf(both('/docs-media/en/x.png', '/docs-media/fr/x.png'), { '/img/b.png': { id: OTHER, ext: 'png' }, '/docs-media/fr/y.png': { id: 'aa11', ext: 'png' } })
    const { after } = await pullBack(root, assets, (doc) => {
      const section = doc.pages[0].page_sections[0]
      const image = (d) => d.content.find((n) => n.type === 'image') ?? d.content.flatMap((n) => n.content || []).find((n) => n.type === 'image')
      Object.assign(image(section.content.fr).attrs ?? image(section.content.fr), { src: SERVED('aa11'), assetId: 'aa11' })
      return doc
    })
    expect(after.fr[h(ALT)]).toBe(`![${ALT_FR}](/docs-media/fr/y.png)`)
  })

  it('CONTROL — the same pull with no shared asset changes no file', async () => {
    const root = site()
    const { before, after } = await pullBack(root, { '/docs-media/en/x.png': { id: ID, ext: 'png' }, '/docs-media/fr/x.png': { id: 'bb22', ext: 'png' }, '/img/b.png': { id: OTHER, ext: 'png' } })
    expect(after.intro).toBe(before.intro)
    expect(after.fr[h(ALT)]).toBe(`![${ALT_FR}](/docs-media/fr/x.png)`)
  })
})
