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
    expect(Object.keys(out)).toEqual(['en']) // no empty es wrapper
    expect(out.en.type).toBe('doc')
  })

  // The field declares `localized: true`, so it ships as a map whatever the
  // language count. This used to return the bare doc whenever nothing had been
  // translated, which made the wire shape depend on whether a given section
  // happened to have a translation — a translated section and its untranslated
  // neighbour left in DIFFERENT shapes on the same page.
  it('ALWAYS wraps — single-locale sites included', () => {
    expect(Object.keys(localizeContentDoc(docOf('Hi'), 'en', [], null))).toEqual(['en'])
    expect(Object.keys(localizeContentDoc(docOf('Hi'), 'en', undefined, undefined))).toEqual(['en'])
  })

  it('passes non-docs through untouched', () => {
    expect(localizeContentDoc(null, 'en', [], null)).toBe(null)
    const already = { en: docOf('Hi') }
    expect(localizeContentDoc(already, 'en', [], null)).toBe(already) // no double wrap
  })

  it('a source-only map round-trips back to a bare doc on the file lane', () => {
    const doc = docOf('Hello world')
    const wrapped = localizeContentDoc(doc, 'en', [], null)
    expect(unwrapLocalizedContent(wrapped, 'en', null, null)).toEqual(doc)
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

describe('containers ride the sync lane too', () => {
  // The build lane (dist/{locale}/) and the sync lane (a self-contained doc per
  // locale) both resolve through the same blockElements collector, so a
  // container that one can translate the other can too. Asserted rather than
  // assumed: this is the lane an app author's copy of the content arrives on,
  // and a concept block whose prose stayed in the source language there would
  // be invisible until someone opened the site in another locale.

  const conceptDoc = (tag, ...blocks) => ({
    type: 'doc',
    content: [{ type: 'concept_block', attrs: { tag }, content: blocks }],
  })
  const h = (text) => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] })
  const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

  it('emits a per-locale doc carrying the translated concept block', () => {
    const source = conceptDoc('faq', h('A question'), p('An answer.'))
    const out = localizeContentDoc(source, 'en', ['fr'], {
      fr: {
        [computeHash('A question')]: 'Une question',
        [computeHash('An answer.')]: 'Une réponse.',
      },
    })

    expect(Object.keys(out).sort()).toEqual(['en', 'fr'])

    const fr = out.fr.content[0]
    expect(fr.type).toBe('concept_block')
    expect(fr.attrs.tag).toBe('faq') // the discriminator survives the wire
    expect(fr.content[0].content[0].text).toBe('Une question')
    expect(fr.content[1].content[0].text).toBe('Une réponse.')

    // The source locale is untouched — nothing is translated in place.
    expect(out.en.content[0].content[0].content[0].text).toBe('A question')
  })

  it('derives the structural map back on pull', () => {
    const source = conceptDoc('faq', h('A question'), p('An answer.'))
    const wire = localizeContentDoc(source, 'en', ['fr'], {
      fr: {
        [computeHash('A question')]: 'Une question',
        [computeHash('An answer.')]: 'Une réponse.',
      },
    })

    const collector = createTranslationCollector('en')
    const back = unwrapLocalizedContent(wire, 'en', collector, 'pages/faq/body')

    // The source doc comes back unchanged, and the target locale reduces to a
    // hash-keyed map — congruent structure, so no free-form body is needed.
    expect(back).toEqual(source)
    expect(collector.freeformPending).toHaveLength(0)
    expect(collector.byLocale.fr[computeHash('A question')]).toBe('Une question')
    expect(collector.byLocale.fr[computeHash('An answer.')]).toBe('Une réponse.')
  })
})

describe('data blocks deliberately do NOT ride the sync wire', () => {
  it('a per-locale doc leaves a tagged data block untranslated', () => {
    // Not an oversight — a scope boundary, and removing it would LOSE data.
    // deriveStructuralMap recovers a pulled translation by walking block
    // elements and comparing their inline content. A dataBlock's payload is
    // neither a block element nor divergence, so a translated one on the wire
    // would be invisible on pull: not captured in the map, not flagged as
    // free-form, silently reverted. The build lane (the manifest and
    // dist/{locale}/) does translate them — that is where the reported bug was.
    // Carrying them across sync needs a representation this contract lacks.
    const doc = {
      type: 'doc',
      content: [{ type: 'dataBlock', attrs: { tag: 'nav', language: 'yaml', data: [{ label: 'Home', href: '/' }] } }],
    }
    const out = localizeContentDoc(doc, 'en', ['fr'], {
      fr: { [computeHash('Home')]: 'Accueil' },
    })

    // Nothing translated → the target locale is omitted entirely and the site
    // falls back to the source, rather than shipping a half-translated doc.
    expect(Object.keys(out)).toEqual(['en'])
    expect(out.en.content[0].attrs.data[0].label).toBe('Home')
  })
})
