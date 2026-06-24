// Localization wire reshape: localizeContentDoc (push) emits a self-contained doc
// per target locale; unwrapLocalizedContent (pull) derives the compact structural
// map back from those docs, treats a reserved `@` key as opaque metadata, and
// falls back to a free-form body when a target diverges structurally.

import { localizeContentDoc, unwrapLocalizedContent, createTranslationCollector } from '../src/uwx/locale-sync.js'
import { computeHash } from '../src/i18n/hash.js'

const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

describe('localizeContentDoc — self-contained per-locale docs (push)', () => {
  it('emits a DOC per target locale, never a structural map', () => {
    const out = localizeContentDoc(docOf('Hello world'), 'en', ['es'], {
      es: { [computeHash('Hello world')]: 'Hola mundo' },
    })
    expect(out.en.type).toBe('doc')
    expect(out.es.type).toBe('doc') // self-contained, renderer-ready (not a source-keyed map)
    expect(JSON.stringify(out.es)).toContain('Hola mundo')
  })

  it('omits an untranslated target locale (it falls back to the source locale)', () => {
    const out = localizeContentDoc(docOf('Hello world'), 'en', ['es'], { es: {} })
    expect(out.type).toBe('doc') // stays a bare source doc — no empty es wrapper
  })
})

describe('unwrapLocalizedContent — derive map from docs (pull)', () => {
  it('treats a reserved @ key as opaque metadata, NEVER a locale', () => {
    const collector = createTranslationCollector('en')
    // a reserved `@` bag plus a `$`-prefixed key — both opaque, neither a locale
    const content = { en: docOf('Hi'), es: docOf('Hola'), '@': { note: 'opaque' }, '$ver': 1 }
    const source = unwrapLocalizedContent(content, 'en', collector)
    expect(source).toBe(content.en)
    expect(Object.keys(collector.byLocale)).toContain('es')
    expect(Object.keys(collector.byLocale)).not.toContain('@') // no locales/@.json corruption
    expect(Object.keys(collector.byLocale)).not.toContain('$ver') // $-prefixed also skipped
  })

  it('derives a structural map from a congruent target doc, value carrying marks/links', () => {
    const collector = createTranslationCollector('en')
    const en = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: '/d' } }] },
    ] }] }
    const es = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Ver ' },
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: '/es/d' } }] },
    ] }] }
    unwrapLocalizedContent({ en, es }, 'en', collector)
    // keyed by the source element's whole text (link inline); value is the target's
    // inline markdown, so the per-locale link href survives.
    const value = collector.byLocale.es[computeHash('See docs')]
    expect(value).toBeDefined()
    expect(value).toContain('/es/d')
  })

  it('notes a structurally divergent target as a free-form body (not a map)', () => {
    const collector = createTranslationCollector('en')
    const es = { type: 'doc', content: [docOf('A').content[0], docOf('B').content[0]] } // 2 paras vs 1
    unwrapLocalizedContent({ en: docOf('One'), es }, 'en', collector, 'pages/home/hero.md')
    expect(collector.byLocale.es).toBeUndefined()
    expect(collector.freeformPending).toHaveLength(1)
    expect(collector.freeformPending[0].locale).toBe('es')
  })
})

describe('localizeContentDoc ⇄ unwrapLocalizedContent — wire round-trip', () => {
  it('push→pull recovers the source-text-keyed map (a link round-trips losslessly)', () => {
    const source = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'our docs', marks: [{ type: 'link', attrs: { href: '/docs' } }] },
      { type: 'text', text: ' now.' },
    ] }] }
    const table = { [computeHash('See our docs now.')]: 'Voir [nos docs](/fr/docs) maintenant.' }

    // push: resolve to a self-contained fr doc
    const wire = localizeContentDoc(source, 'en', ['fr'], { fr: table })
    expect(wire.fr.type).toBe('doc')

    // pull: derive the map back from the fr doc
    const collector = createTranslationCollector('en')
    unwrapLocalizedContent(wire, 'en', collector)
    expect(collector.byLocale.fr[computeHash('See our docs now.')]).toBe('Voir [nos docs](/fr/docs) maintenant.')
  })
})
