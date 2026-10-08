// Localization wire reshape: localizeContentDoc (push) emits a self-contained doc
// per target locale; unwrapLocalizedContent (pull) derives the compact structural
// map back from those docs, treats a reserved `@` key as opaque metadata, and
// falls back to a free-form body when a target diverges structurally.

import { localizeContentDoc, unwrapLocalizedContent, createTranslationCollector, writeLocaleTranslations } from '../src/uwx/locale-sync.js'
import { computeHash } from '../src/i18n/hash.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('data blocks ride the sync wire — both ways', () => {
  // ⛔ Until 2026-09-26 they were kept off the wire deliberately: the pull could not read a
  // translated data block back, so carrying one would have lost it silently on the next pull. The
  // pull reads them now (`deriveStructuralMap`), so the two halves travel together.
  const doc = {
    type: 'doc',
    content: [{ type: 'dataBlock', attrs: { tag: 'nav', language: 'yaml', data: [{ label: 'Home', href: '/' }] } }],
  }

  it('⭐ a per-locale doc translates a data block’s prose, and a pull reads it back per string', () => {
    const out = localizeContentDoc(doc, 'en', ['fr'], { fr: { [computeHash('Home')]: 'Accueil' } })
    expect(out.fr.content[0].attrs.data[0]).toEqual({ label: 'Accueil', href: '/' })
    expect(out.en.content[0].attrs.data[0].label).toBe('Home') // the source is untouched
    const collector = createTranslationCollector('en')
    unwrapLocalizedContent(out, 'en', collector)
    expect(collector.byLocale.fr[computeHash('Home')]).toBe('Accueil')
    expect(collector.freeformPending).toEqual([])
  })

  it('a target that changed more than its prose — another href — is a free-form translation', () => {
    const target = JSON.parse(JSON.stringify(doc))
    target.content[0].attrs.data[0] = { label: 'Accueil', href: '/fr' }
    const collector = createTranslationCollector('en')
    unwrapLocalizedContent({ en: doc, fr: target }, 'en', collector, 'pages/nav.md')
    expect(collector.byLocale.fr).toBeUndefined()
    expect(collector.freeformPending.map((e) => e.relpath)).toEqual(['pages/nav.md'])
  })
})

describe('context-specific overrides come back as the author keeps them', () => {
  const key = computeHash('Learn more.')
  const AUTHORED = { default: 'Más información.', overrides: { '/about:more': 'Conoce nuestra historia.' } }
  let root
  afterEach(() => root && rmSync(root, { recursive: true, force: true }))

  // A pull that read `Learn more.` on the homepage and on the About page, translated as given.
  function pull(existing, onHome, onAbout) {
    root = mkdtempSync(join(tmpdir(), 'overrides-'))
    if (existing !== undefined) {
      mkdirSync(join(root, 'locales'), { recursive: true })
      writeFileSync(join(root, 'locales', 'es.json'), JSON.stringify({ [key]: existing }, null, 2) + '\n')
    }
    const collector = createTranslationCollector('en')
    collector.addStructuralMap('es', { 'Learn more.': onHome }, { page: '/', section: 'more' })
    collector.addStructuralMap('es', { 'Learn more.': onAbout }, { page: '/about', section: 'more' })
    const report = writeLocaleTranslations(root, collector.byLocale)
    return { report, entry: JSON.parse(readFileSync(join(root, 'locales', 'es.json'), 'utf8'))[key] }
  }

  it('⭐ unchanged: the file is left as it was', () => {
    const { report, entry } = pull(AUTHORED, 'Más información.', 'Conoce nuestra historia.')
    expect(report.es).toBe('unchanged')
    expect(entry).toEqual(AUTHORED)
  })

  it('the default changed in the app: the default follows, the override stays', () => {
    const { entry } = pull(AUTHORED, 'Descubre más.', 'Conoce nuestra historia.')
    expect(entry).toEqual({ default: 'Descubre más.', overrides: { '/about:more': 'Conoce nuestra historia.' } })
  })

  it('an override that now says the default is dropped', () => {
    const { entry } = pull(AUTHORED, 'Más información.', 'Más información.')
    expect(entry).toBe('Más información.')
  })

  it('a clone: places that disagree become `{ default, overrides }`, the first read the default', () => {
    const { entry } = pull(undefined, 'Más información.', 'Conoce nuestra historia.')
    expect(entry).toEqual(AUTHORED)
  })

  it('CONTROL — places that agree stay one string', () => {
    expect(pull(undefined, 'Más información.', 'Más información.').entry).toBe('Más información.')
  })
})

describe('a pull that changes one translation changes that line alone', () => {
  let root
  afterEach(() => root && rmSync(root, { recursive: true, force: true }))

  // ⛔ A hash of digits alone (`19544096`, about one in fifty) is an integer-like key, which a
  // JavaScript object puts first — so until 2026-09-26 such an entry moved to the top of the file.
  it('⭐ an entry whose hash is all digits keeps its place', () => {
    root = mkdtempSync(join(tmpdir(), 'order-'))
    mkdirSync(join(root, 'locales'))
    const file = join(root, 'locales', 'es.json')
    const before = '{\n  "620d9c54": "Protegiendo",\n  "19544096": "El Modelo",\n  "e578c36b": "El Desafio"\n}\n'
    writeFileSync(file, before)

    expect(writeLocaleTranslations(root, { es: { e578c36b: 'El Reto', '30000000': 'Nuevo' } }).es).toBe('updated')
    expect(readFileSync(file, 'utf8')).toBe(before.replace('"El Desafio"\n', '"El Reto",\n  "30000000": "Nuevo"\n'))
  })
})

// ⛔ Measured 2026-10-08 on the `international` template: a pull into the copy that pushed rewrote
// `"Donar Ahora"` — the label of the button `[Donate Now](/contact)` — as `"[Donar Ahora](/contact)"`,
// and split `"Apoyanos"`, which a page title and a button share, into a default and two overrides.
// The merge reads a label onto the source's own link (`translatedInline`), so the pull writes the
// label back — and the label keeps following the source's link, which the link written out would not.
describe('a translation of only a link’s words comes back as its label', () => {
  const para = (...content) => ({ type: 'doc', content: [{ type: 'paragraph', content }] })
  const link = (text, href, more = []) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }, ...more] })
  const br = { type: 'hardBreak' }
  const pulled = (en, es) => {
    const collector = createTranslationCollector('en')
    unwrapLocalizedContent({ en, es }, 'en', collector)
    return collector.byLocale.es || {}
  }
  const BUTTON = para(link('Donate Now', '/contact'))

  it('⭐ a button: the label, as a translator writes it', () => {
    expect(pulled(BUTTON, para(link('Donar Ahora', '/contact')))).toEqual({ [computeHash('Donate Now')]: 'Donar Ahora' })
  })

  it('⭐ a push and a pull leave the label as written', () => {
    const wire = localizeContentDoc(BUTTON, 'en', ['es'], { es: { [computeHash('Donate Now')]: 'Donar Ahora' } })
    expect(JSON.stringify(wire.es)).toContain('/contact') // the push sends the button, link and all
    const collector = createTranslationCollector('en')
    unwrapLocalizedContent(wire, 'en', collector)
    expect(collector.byLocale.es).toEqual({ [computeHash('Donate Now')]: 'Donar Ahora' })
  })

  it('…and the label keeps following the source’s link, where the link written out would not', () => {
    const value = pulled(BUTTON, para(link('Donar Ahora', '/contact')))[computeHash('Donate Now')]
    const moved = localizeContentDoc(para(link('Donate Now', '/donate')), 'en', ['es'], { es: { [computeHash('Donate Now')]: value } })
    expect(JSON.stringify(moved.es)).toContain('/donate')
    const pinned = localizeContentDoc(para(link('Donate Now', '/donate')), 'en', ['es'], {
      es: { [computeHash('Donate Now')]: '[Donar Ahora](/contact)' },
    })
    expect(JSON.stringify(pinned.es)).not.toContain('/donate')
  })

  it('several links: a label a line', () => {
    const en = para(link('Support', '/contact'), br, link('Learn More', '/about'))
    const es = para(link('Apoyar', '/contact'), br, link('Saber Más', '/about'))
    expect(Object.values(pulled(en, es))).toEqual(['Apoyar\nSaber Más'])
  })

  it('a mark the link carries is the link’s — the label is the words', () => {
    const bold = [{ type: 'bold' }]
    expect(Object.values(pulled(para(link('Donate', '/c', bold)), para(link('Donar', '/c', bold))))).toEqual(['Donar'])
  })

  it('CONTROL — a link the translator changed is written whole', () => {
    expect(Object.values(pulled(BUTTON, para(link('Donar Ahora', '/es/donar'))))).toEqual(['[Donar Ahora](/es/donar)'])
  })

  it('CONTROL — words beside a link are written whole: which words a label covers is not known', () => {
    const en = para({ type: 'text', text: 'See ' }, link('docs', '/d'))
    const es = para({ type: 'text', text: 'Ver ' }, link('docs', '/d'))
    expect(Object.values(pulled(en, es))).toEqual(['Ver [docs](/d)'])
  })

  it('⭐ a string a page title and a button share stays one entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'labels-'))
    try {
      const collector = createTranslationCollector('en')
      unwrapLocalizedContent({ en: para({ type: 'text', text: 'Support Us' }), es: para({ type: 'text', text: 'Apoyanos' }) }, 'en', collector, null, null, { page: '/contact', section: 'hero' })
      unwrapLocalizedContent({ en: para(link('Support Us', '/contact')), es: para(link('Apoyanos', '/contact')) }, 'en', collector, null, null, { page: '/', section: 'cta' })
      writeLocaleTranslations(root, collector.byLocale)
      expect(JSON.parse(readFileSync(join(root, 'locales', 'es.json'), 'utf8'))).toEqual({ [computeHash('Support Us')]: 'Apoyanos' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
