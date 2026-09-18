/**
 * The translator-facing half of a unit, end to end.
 *
 * THE INCIDENT THIS PINS (2026-09-18, @uniweb/build 0.44.4). A documentation site
 * was translated to French at 100% coverage per `uniweb i18n status`, and the built
 * French pages rendered a=0 strong=0 em=0 where English rendered a=15 strong=20
 * em=2. The text was complete and correct; every inline mark was gone.
 *
 * Nothing was broken. `merge` has parsed a translation VALUE as inline markdown
 * since 2026-06-24, so the value channel was lossless the whole time — but
 * extraction stored only the FLATTENED text, `uniweb i18n generate` seeded the
 * locale file from it, and the translator was handed a paragraph whose link had
 * already been removed. They cannot restore what they were never shown.
 *
 * ⇒ These tests assert the two halves that must hold together: the hash stays on
 * the plain text (so marking a sentence up never orphans its translation), and the
 * unit carries the markup a translator needs to carry the link across.
 */
import { extractTranslatableContent, elementMarkup } from '../../src/i18n/extract.js'
import { mergeTranslations } from '../../src/i18n/merge.js'
import { syncManifests } from '../../src/i18n/sync.js'
import { computeHash } from '../../src/i18n/hash.js'
import { markdownToProseMirror } from '@uniweb/content-reader'

const LINKED = `That's controlled by your role. See [Roles and permissions](page:docs/collaboration/roles-and-permissions).`
const PLAIN_TEXT = `That's controlled by your role. See Roles and permissions.`

function siteWith(markdown) {
  return {
    config: { defaultLanguage: 'en' },
    pages: [
      {
        route: '/docs/reference/faq',
        sections: [{ id: 'sec1', content: markdownToProseMirror(markdown) }]
      }
    ]
  }
}

describe('a unit carries the markup a translator needs', () => {
  it('keys on the flattened text and stores the inline markdown beside it', () => {
    const manifest = extractTranslatableContent(siteWith(LINKED))
    const hash = computeHash(PLAIN_TEXT)

    expect(manifest.units[hash]).toBeDefined()
    // The KEY is the flattened text — unchanged, and deliberately so.
    expect(manifest.units[hash].source).toBe(PLAIN_TEXT)
    // The PROMPT is the markdown, with the page: href intact.
    expect(manifest.units[hash].markup).toBe(LINKED)
  })

  it('omits markup on plain prose, so most units gain nothing', () => {
    const manifest = extractTranslatableContent(siteWith(PLAIN_TEXT))
    const hash = computeHash(PLAIN_TEXT)

    expect(manifest.units[hash].source).toBe(PLAIN_TEXT)
    expect(manifest.units[hash].markup).toBeUndefined()
  })

  it('keeps the hash stable when a link is added to an unchanged sentence', () => {
    // This is what makes plain-text keying worth defending: the existing
    // translation is not orphaned when an author marks a sentence up.
    const before = extractTranslatableContent(siteWith(PLAIN_TEXT))
    const after = extractTranslatableContent(siteWith(LINKED))

    expect(Object.keys(after.units)).toEqual(Object.keys(before.units))
  })

  it('reports that link as remarked, which the hash alone cannot see', () => {
    const before = extractTranslatableContent(siteWith(PLAIN_TEXT))
    const after = extractTranslatableContent(siteWith(LINKED))
    const report = syncManifests(before, after)

    expect(report.changed).toHaveLength(0)
    expect(report.added).toHaveLength(0)
    expect(report.remarked).toHaveLength(1)
    expect(report.remarked[0].currentMarkup).toBe(LINKED)
    expect(report.remarked[0].previousMarkup).toBeNull()
  })
})

describe('what the merge does with each kind of value', () => {
  const site = siteWith(LINKED)
  const hash = computeHash(PLAIN_TEXT)

  const marksIn = (content) =>
    JSON.stringify(content).match(/"type":"(link|bold|italic)"/g) || []

  it('renders flat prose from a flat value — the reported symptom', () => {
    const out = mergeTranslations(site, {
      [hash]: 'Cela dépend de votre rôle. Voir Rôles et permissions.'
    })
    expect(marksIn(out.pages[0].sections[0].content)).toEqual([])
  })

  it('restores the link, and its page: href, from a markdown value', () => {
    const out = mergeTranslations(site, {
      [hash]:
        'Cela dépend de votre rôle. Voir [Rôles et permissions](page:docs/collaboration/roles-and-permissions).'
    })
    const content = out.pages[0].sections[0].content
    expect(marksIn(content)).toContain('"type":"link"')
    expect(JSON.stringify(content)).toContain(
      'page:docs/collaboration/roles-and-permissions'
    )
  })

  it('round-trips a unit\'s own markup back to the source fragment', () => {
    // The manifest value is not merely descriptive: fed back through merge it
    // reconstructs the element it came from. That is what makes it a safe thing
    // to hand a translator.
    const source = markdownToProseMirror(LINKED).content[0]
    const manifest = extractTranslatableContent(siteWith(LINKED))
    const out = mergeTranslations(siteWith(LINKED), {
      [hash]: manifest.units[hash].markup
    })
    expect(out.pages[0].sections[0].content.content[0].content).toEqual(
      source.content
    )
  })
})

describe('elementMarkup', () => {
  it('returns null when an element adds nothing over its plain text', () => {
    const node = markdownToProseMirror(PLAIN_TEXT).content[0]
    expect(elementMarkup(node)).toBeNull()
  })

  it('serializes a heading\'s inline marks', () => {
    const node = markdownToProseMirror('## A **bold** heading').content[0]
    expect(elementMarkup(node)).toBe('A **bold** heading')
  })
})
