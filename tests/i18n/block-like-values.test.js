/**
 * A translation that begins like a markdown block is still one element's words.
 *
 * A value is read as inline markdown (`merge.js::inlineMarkdownToFragment`, `toPlainText`).
 * ⛔ Until 2026-10-24 it was read as a document: `1. Informations que nous collectons`, the French
 * of a numbered heading, was an ordered list, and the heading was handed its list item. It rendered
 * empty in both lanes, and a pull refused the site, since no file can say a heading holds a list
 * item (measured that day on a published site whose legal page numbers its headings).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSiteData } from '../../src/site/index.js'
import { buildLocalizedContent } from '../../src/i18n/index.js'
import { translatedInline, toPlainText } from '../../src/i18n/merge.js'
import { computeHash as h } from '../../src/i18n/hash.js'
import { siteProjectToDocument } from '../../src/uwx/index.js'

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'i18n-block-like-'))
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
const text = (t) => ({ type: 'text', text: t })

describe('a value that begins like a block is its words', () => {
  it.each([
    ['1. Information We Collect', '1. Informations que nous collectons'],
    ['- Draft', '- Brouillon'],
    ['> Note', '> Remarque'],
    ['# 1', '# 1'],
  ])('%s → %s', (source, value) => {
    expect(translatedInline([text(source)], value)).toEqual([text(value)])
  })

  it('a plain-text place keeps the marker too', () => {
    expect(toPlainText('1. *Introduction*')).toBe('1. Introduction')
    expect(toPlainText('- [Accueil](/)')).toBe('- Accueil')
    // CONTROL: paragraphs stay apart, as they did.
    expect(toPlainText('Lun–Ven 9h–17h\n\n*Fermé les jours fériés*')).toBe('Lun–Ven 9h–17h Fermé les jours fériés')
  })
})

describe('a numbered heading, translated', () => {
  function site() {
    const root = tmp()
    write(root, {
      'site.yml': 'name: Site\ndefaultLanguage: en\nlanguages: [en, fr]\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n',
      'pages/home/page.yml': 'title: Home\n',
      'pages/home/1-policy.md': '---\ntype: Article\n---\n\n## 1. Information We Collect\n\nWhat we ask for.\n',
      'locales/fr.json': {
        [h('1. Information We Collect')]: '1. Informations que nous collectons',
        [h('What we ask for.')]: 'Ce que nous demandons.',
      },
    })
    return root
  }
  const heading = (doc) => doc?.content?.find((b) => b.type === 'heading')

  it('the static build gives the French heading its words', async () => {
    const root = site()
    await quiet(async () => {
      await buildSiteData({ siteRoot: root, distDir: join(root, 'dist'), foundationPath: null })
      await buildLocalizedContent(root, { locales: ['fr'], localesDir: 'locales' })
    })
    const sectionOf = (file) => JSON.parse(readFileSync(join(root, file), 'utf8')).pages.find((p) => p.route === '/').sections[0]
    expect(heading(sectionOf('dist/fr/site-content.json').content).content).toEqual([text('1. Informations que nous collectons')])
    // CONTROL: the source is untouched.
    expect(heading(sectionOf('dist/site-content.json').content).content).toEqual([text('1. Information We Collect')])
  })

  it('a push sends the French heading as its words', async () => {
    const doc = await quiet(() => siteProjectToDocument(site()))
    const content = doc.pages.find((p) => p.title?.en === 'Home').page_sections[0].content
    expect(heading(content.fr).content).toEqual([text('1. Informations que nous collectons')])
    expect(heading(content.en).content).toEqual([text('1. Information We Collect')])
  })
})
