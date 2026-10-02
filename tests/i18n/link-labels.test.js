/**
 * ⭐ A BUTTON'S TRANSLATION IS ITS LABEL. A value that names no link, given to an element made
 * only of links, keeps those links — target and attributes — with the value as their labels: the
 * whole value for one link, a line each for several (`translatedInline`, merge.js).
 *
 * THE REPORT THIS PINS (2026-10-01, uniweb 0.80.8): on translated pages a standalone link came out
 * as a plain paragraph or not at all, and two links on consecutive lines — one paragraph, so one
 * unit — stayed untranslated. The locale files held labels: `Créer un groupe` for
 * `[Create Group](/create){role=primary}`, some keyed before whole-element keying (`link.label`).
 * The merge replaced the element with the value whole, so a label replaced the link.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeTranslations, resolveDocForLocale, translatedInline } from '../../src/i18n/merge.js'
import { extractTranslatableContent } from '../../src/i18n/extract.js'
import { auditLocale } from '../../src/i18n/audit.js'
import { computeHash } from '../../src/i18n/hash.js'
import { markdownToProseMirror } from '@uniweb/content-reader'

const BUTTON = '[Create Group](/create){role=primary}'
const TWO_BUTTONS =
  '[Read the Whitepaper](/engine){role=primary icon=lu-file-text}\n[Audit the Architecture](/transparency){role=secondary icon=lu-code-xml}'
const MIXED = 'Read [our guide](/guide) first.'

const siteWith = (markdown) => ({
  config: { defaultLanguage: 'en' },
  pages: [{ route: '/', sections: [{ id: '1', content: markdownToProseMirror(markdown) }] }],
})
const inlineOf = (markdown) => markdownToProseMirror(markdown).content[0].content
const translate = (markdown, value) => {
  const [hash] = Object.keys(extractTranslatableContent(siteWith(markdown)).units)
  return mergeTranslations(siteWith(markdown), { [hash]: value }).pages[0].sections[0].content.content[0].content
}
const linkOf = (node) => node.marks?.find((mark) => mark.type === 'link')?.attrs

describe('a value that names no link, for an element made only of links', () => {
  it('a button keeps its link — target and attributes — with the value as its label', () => {
    const out = translate(BUTTON, 'Créer un groupe')
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('Créer un groupe')
    expect(linkOf(out[0])).toMatchObject({ href: '/create', role: 'primary' })
  })

  it('buttons on consecutive lines take a label each, one per line, and keep the line between them', () => {
    const out = translate(TWO_BUTTONS, "Lire le livre blanc\nAuditer l'architecture")
    const labels = out.filter((node) => linkOf(node))
    expect(labels.map((node) => node.text)).toEqual(['Lire le livre blanc', "Auditer l'architecture"])
    expect(linkOf(labels[0])).toMatchObject({ href: '/engine', role: 'primary', icon: 'lu-file-text' })
    expect(linkOf(labels[1])).toMatchObject({ href: '/transparency', role: 'secondary', icon: 'lu-code-xml' })
    expect(out.map((node) => node.text)).toEqual(['Lire le livre blanc', '\n', "Auditer l'architecture"])
  })

  it('emphasis in the label stays, inside the link', () => {
    const out = translate(BUTTON, '**Créer** un groupe')
    expect(out.map((node) => node.text)).toEqual(['Créer', ' un groupe'])
    expect(out.every((node) => linkOf(node)?.href === '/create')).toBe(true)
    expect(out[0].marks.map((mark) => mark.type)).toEqual(['link', 'bold'])
  })

  it('a link whose text has several runs is still one link; the label takes the marks all its text shares', () => {
    const out = translatedInline(inlineOf('[**Create** Group](/create)'), 'Créer un groupe')
    expect(out).toEqual([{ type: 'text', text: 'Créer un groupe', marks: [expect.objectContaining({ type: 'link' })] }])
  })
})

describe('what is still taken as written', () => {
  it('a value that writes its own link — re-targeted here', () => {
    const out = translate(BUTTON, '[Créer un groupe](/fr/creer){role=primary}')
    expect(out).toHaveLength(1)
    expect(linkOf(out[0])).toMatchObject({ href: '/fr/creer', role: 'primary' })
  })

  it('labels that do not match the links one to one — two buttons, one line', () => {
    const out = translate(TWO_BUTTONS, 'Lire le livre blanc ou auditer')
    expect(out.some((node) => linkOf(node))).toBe(false)
  })

  it('a plain value for an element that mixes words and links: which words were linked cannot be known', () => {
    const out = translate(MIXED, 'Lisez d\'abord notre guide.')
    expect(out).toEqual([{ type: 'text', text: 'Lisez d\'abord notre guide.' }])
  })

  it('CONTROL — no translation leaves the button as authored', () => {
    const out = translate(BUTTON, 'Create Group')
    expect(linkOf(out[0])).toMatchObject({ href: '/create', role: 'primary' })
  })
})

describe('the push and the audit ask the same function', () => {
  it('a push resolves a locale\'s doc the same way', () => {
    const doc = markdownToProseMirror(BUTTON)
    const resolved = resolveDocForLocale(doc, { [computeHash('Create Group')]: 'Créer un groupe' })
    expect(linkOf(resolved.content[0].content[0])).toMatchObject({ href: '/create', role: 'primary' })
  })

  describe('i18n status', () => {
    let dir
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'uw-link-labels-'))
      const units = {}
      for (const markdown of [BUTTON, TWO_BUTTONS, MIXED]) {
        Object.assign(units, extractTranslatableContent(siteWith(markdown)).units)
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '1.0', units }))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('reports a translation that loses its links, and not a label the merge keeps a link for', async () => {
      writeFileSync(
        join(dir, 'fr.json'),
        JSON.stringify({
          [computeHash('Create Group')]: 'Créer un groupe',
          [computeHash('Read the Whitepaper\nAudit the Architecture')]: "Lire le livre blanc\nAuditer l'architecture",
          [computeHash('Read our guide first.')]: "Lisez d'abord notre guide.",
        })
      )
      const audit = await auditLocale(dir, 'fr')
      expect(audit.valid).toHaveLength(3)
      expect(audit.losesMarkup.map((entry) => entry.source)).toEqual(['Read our guide first.'])
    })
  })
})
