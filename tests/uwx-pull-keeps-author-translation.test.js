/**
 * ⭐ A PULL KEEPS THE AUTHOR'S TRANSLATION WHEREVER IT STILL SAYS WHAT EVERY PLACE READ.
 *
 * A pull reads one spelling of each translation back, and an author's entry can say the same thing
 * in another: a link written whole with the source's own href, which the merge would read as the
 * label it puts on that link; a page title's link, which the push sends as its words. Each place is
 * judged by the push's own rule for it (`uwx/locale-sync.js`, the collector's checks), so the entry
 * is kept as written. ⛔ Until 2026-10-17 values agreed only when spelled alike, and a pull into the
 * copy that pushed rewrote such an entry — to its label, into per-place overrides, or to a page
 * title's words — though every page rendered the same.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeHash as h } from '../src/i18n/hash.js'
import { siteProjectToDocument, siteContentDocumentToProject, createTranslationCollector, writeLocaleTranslations } from '../src/uwx/index.js'

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

const SITE = 'name: Site\ndefaultLanguage: en\nlanguages: [en, fr]\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n'

function project(files, fr) {
  const root = mkdtempSync(join(tmpdir(), 'pull-keeps-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries({ 'site.yml': SITE, ...files, 'locales/fr.json': JSON.stringify(fr, null, 2) + '\n' })) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

// Push the project, let `edit` change what the backend holds, and pull it back into the same copy.
async function roundTrip(root, edit = () => {}) {
  const before = readFileSync(join(root, 'locales/fr.json'), 'utf8')
  const document = JSON.parse(JSON.stringify(await quiet(() => siteProjectToDocument(root))))
  edit(document)
  await quiet(() => siteContentDocumentToProject({ document, siteRoot: root, prune: true }))
  const after = readFileSync(join(root, 'locales/fr.json'), 'utf8')
  return { before, after, fr: JSON.parse(after) }
}

const GIVE = { 'pages/home/page.yml': 'title: Home\n', 'pages/home/1-give.md': '---\ntype: Give\n---\n\n## Support us\n\n[Donate now](/contact)\n' }
// A text a header says as a heading and a page says as a link.
const SHARED = {
  'layout/header.md': '---\ntype: Header\n---\n\n# Faculty of Science\n',
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/1-directory.md': '---\ntype: Directory\n---\n\n## People\n\n[Faculty of Science](/)\n',
}
// A page whose title is the text a header link says.
const TITLED = {
  'layout/header.md': '---\ntype: Header\n---\n\n[Sign in](/sign-in)\n',
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/1-a.md': '---\ntype: A\n---\n\n# Welcome\n',
  'pages/sign-in/page.yml': 'title: Sign in\n',
  'pages/sign-in/1-form.md': '---\ntype: SignIn\n---\n\n# Hello\n',
}

describe('a pull into the copy that pushed', () => {
  it('⭐ keeps a link written whole with the source’s own href — not only its label', async () => {
    const root = project(GIVE, { [h('Donate now')]: '[Faire un don](/contact)', [h('Support us')]: 'Soutenez-nous' })
    const { before, after } = await roundTrip(root)
    expect(after).toBe(before)
  })

  it('⭐ keeps a string a heading and a link share, written as the link — no per-place overrides', async () => {
    const root = project(SHARED, { [h('Faculty of Science')]: '[Faculté des sciences](/)', [h('People')]: 'Personnes' })
    const { before, after } = await roundTrip(root)
    expect(after).toBe(before)
  })

  it('⭐ keeps a page title’s string written as the link a header says — not the title’s words', async () => {
    const root = project(TITLED, { [h('Sign in')]: '[Se connecter](/sign-in)' })
    const { before, after } = await roundTrip(root)
    expect(after).toBe(before)
  })

  it('CONTROL — keeps a label, and a link with an href of its own, as it always has', async () => {
    for (const value of ['Faire un don', '[Faire un don](/fr/contact)']) {
      const root = project(GIVE, { [h('Donate now')]: value, [h('Support us')]: 'Soutenez-nous' })
      const { before, after } = await roundTrip(root)
      expect(after, value).toBe(before)
    }
  })
})

describe('a pull that brings a change in one place', () => {
  it('⭐ overrides that place alone, and keeps the author’s default where it still holds', async () => {
    const root = project(SHARED, { [h('Faculty of Science')]: '[Faculté des sciences](/)', [h('People')]: 'Personnes' })
    // Someone retitled the header's heading, and left the page's link as it was.
    const { fr } = await roundTrip(root, (document) => {
      const header = document.layout_sections.find((s) => s.stable_id === 'header').content.fr
      header.content[0].content = [{ type: 'text', text: 'Faculté' }]
    })
    const entry = fr[h('Faculty of Science')]
    expect(entry.default).toBe('[Faculté des sciences](/)')
    expect(Object.values(entry.overrides)).toEqual(['Faculté'])
  })

  it('a string read in one place keeps the author’s overrides for places the pull did not see', () => {
    const root = mkdtempSync(join(tmpdir(), 'pull-keeps-'))
    dirs.push(root)
    mkdirSync(join(root, 'locales'), { recursive: true })
    writeFileSync(join(root, 'locales/fr.json'), JSON.stringify({ [h('Hello')]: { default: 'Salut', overrides: { '/about:hero': 'Coucou' } } }, null, 2) + '\n')
    const collector = createTranslationCollector('en')
    collector.add({ en: 'Hello', fr: 'Bonjour' })
    writeLocaleTranslations(root, collector.byLocale, '', collector.says)
    expect(JSON.parse(readFileSync(join(root, 'locales/fr.json'), 'utf8'))[h('Hello')]).toEqual({ default: 'Bonjour', overrides: { '/about:hero': 'Coucou' } })
  })
})
