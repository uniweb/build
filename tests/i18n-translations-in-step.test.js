/**
 * ⭐ WHAT THE APP KEEPS BESIDE A TRANSLATION SURVIVES A PULL AND A PUSH (kb/frontend/plans/translations-in-step.md § 6).
 *
 * The app keeps a translated row when its source changes, flagged by a map in `@.translations` of what
 * each row was made from. So a pull must not read that row as the new source's translation, and a push
 * must send back the row and the map, for THE ROUND-TRIP LAW holds: a document pulled and pushed is the
 * document it was. Measured 2026-10-31 on a local backend with the real editor, before this: a pull wrote
 * the old Spanish under the new English's hash, and the next push removed `@`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordsToEntities, recordsToProject, siteContentDocumentToProject, siteProjectToDocument } from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'
import { availableLocales } from '../src/i18n/locales.js'
import { getRecordLocales } from '../src/i18n/records.js'
import { canonicalJson } from '../src/uwx/same-content.js'

const text = (value) => ({ type: 'text', text: value })
const paragraph = (value) => ({ type: 'paragraph', content: [text(value)] })
const doc = (...values) => ({ type: 'doc', content: values.map(paragraph) })

// One page with one section, as the store holds it.
const site = (content, languages = ['en', 'es', 'fr']) => ({
  info: { name: { en: 'S' }, foundation: '@a/base' },
  settings: { default_language: 'en', languages },
  pages: [
    {
      $id: 'about',
      slug: { en: 'about' },
      mode: 'page',
      stable_id: 'about',
      title: { en: 'About' },
      page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content }],
    },
  ],
})

// The app's state after a source edit: `Old words here` became `Old words here today`.
const edited = () => ({
  en: doc('Old words here today', 'Second line'),
  es: doc('Palabras viejas', 'Segunda linea'),
  fr: doc('Mots anciens', 'Seconde ligne'),
  '@': { translations: { 'Old words here': { es: [text('Palabras viejas')], fr: [text('Mots anciens')] } } },
})

describe('a pull and a push keep the app’s translations in step', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'in-step-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const pull = (document) => siteContentDocumentToProject({ siteRoot: dir, document })
  const read = (name) => JSON.parse(readFileSync(join(dir, 'locales', name), 'utf8'))
  const pushed = async () => (await siteProjectToDocument(dir)).pages[0].page_sections[0].content

  it('⭐ a flagged row is recorded as outdated, not as the new source’s, and still reads as it did', async () => {
    pull(site(edited()))
    const es = read('es.json')
    const flagged = es[computeHash('Old words here today')]
    expect(flagged).toEqual({ default: 'Palabras viejas', outdated: { '/about:hero': 'Old words here' } })
    expect(es[computeHash('Second line')]).toBe('Segunda linea')
    // The round trip is a fixed point: the row, the other row and the map all go back as they were.
    const content = await pushed()
    expect(canonicalJson(content)).toBe(canonicalJson(edited()))
  })

  it('a pull that changes nothing writes nothing', () => {
    pull(site(edited()))
    const before = [readFileSync(join(dir, 'locales/es.json'), 'utf8'), readFileSync(join(dir, 'locales/_kept.json'), 'utf8')]
    pull(site(edited()))
    expect(readFileSync(join(dir, 'locales/es.json'), 'utf8')).toBe(before[0])
    expect(readFileSync(join(dir, 'locales/_kept.json'), 'utf8')).toBe(before[1])
  })

  it('when the app clears the flag, by "still correct" or an edit, the entry is a plain translation', () => {
    pull(site(edited()))
    const reviewed = edited()
    delete reviewed['@'].translations // "still correct" removes the map's entry
    reviewed.es = doc('Palabras viejas', 'Segunda linea')
    pull(site(reviewed))
    expect(read('es.json')[computeHash('Old words here today')]).toBe('Palabras viejas')
    // Nothing left to keep, so nothing is on disk for it.
    expect(existsSync(join(dir, 'locales/_kept.json'))).toBe(false)
  })

  it('a translation typed over the flagged one is recorded as it is', () => {
    pull(site(edited()))
    const retyped = edited()
    retyped.es = doc('Palabras nuevas de hoy', 'Segunda linea')
    pull(site(retyped))
    expect(read('es.json')[computeHash('Old words here today')]).toBe('Palabras nuevas de hoy')
  })

  it('⭐ a cleared translation stays cleared: the row holds its source, and the entry goes', async () => {
    pull(site({ en: doc('First line', 'Second line'), es: doc('Primera', 'Segunda') }))
    expect(read('es.json')[computeHash('First line')]).toBe('Primera')
    pull(site({ en: doc('First line', 'Second line'), es: doc('First line', 'Segunda') }))
    const es = read('es.json')
    expect(computeHash('First line') in es).toBe(false)
    expect(es[computeHash('Second line')]).toBe('Segunda')
    expect((await pushed()).es.content[0].content[0].text).toBe('First line')
  })

  it('CONTROL — an entry the author wrote to say its source is no translation cleared', () => {
    mkdirSync(join(dir, 'locales'))
    writeFileSync(join(dir, 'locales/es.json'), JSON.stringify({ [computeHash('Uniweb')]: 'Uniweb' }))
    pull(site({ en: doc('Uniweb', 'Second line'), es: doc('Uniweb', 'Segunda') }))
    expect(read('es.json')[computeHash('Uniweb')]).toBe('Uniweb')
  })

  it('CONTROL — nor is an entry that gives the row its source in another spelling: a link’s label', () => {
    mkdirSync(join(dir, 'locales'))
    const link = { type: 'paragraph', content: [{ type: 'text', text: 'Pricing', marks: [{ type: 'link', attrs: { href: '/pricing' } }] }] }
    writeFileSync(join(dir, 'locales/es.json'), JSON.stringify({ [computeHash('Pricing')]: 'Pricing' }))
    pull(site({ en: { type: 'doc', content: [link] }, es: { type: 'doc', content: [link] } }))
    expect(read('es.json')[computeHash('Pricing')]).toBe('Pricing')
  })

  it('a row cleared in one section keeps its text there, where another section reads the translation', async () => {
    const document = site({ en: doc('Shared words'), es: doc('Palabras compartidas') })
    document.pages[0].page_sections.push({ $id: 'more', stable_id: 'more', type: 'Hero', content: { en: doc('Shared words'), es: doc('Shared words') } })
    pull(document)
    expect(read('es.json')[computeHash('Shared words')]).toEqual({ default: 'Palabras compartidas', overrides: { '/about:more': 'Shared words' } })
    const sections = (await siteProjectToDocument(dir)).pages[0].page_sections
    // The second has nothing translated, so a push sends no Spanish for it, and its source shows.
    expect(sections.map((s) => s.content.es?.content[0].content[0].text)).toEqual(['Palabras compartidas', undefined])
  })

  it('⭐ one source text holding two translations stays lossless: the language goes free-form', async () => {
    const content = { en: doc('Same words', 'Same words', 'Other'), es: doc('Uno', 'Dos', 'Otro') }
    pull(site(content))
    expect(existsSync(join(dir, 'locales/es.json'))).toBe(false)
    expect(readFileSync(join(dir, 'locales/freeform/es/page-ids/about/hero.md'), 'utf8')).toMatch(/Uno[\s\S]*Dos/)
    const back = await pushed()
    expect(back.es.content.map((p) => p.content[0].text)).toEqual(['Uno', 'Dos', 'Otro'])
  })

  it('CONTROL — the same translation twice is one entry, as it always was', () => {
    pull(site({ en: doc('Same words', 'Same words'), es: doc('Uno', 'Uno') }))
    expect(read('es.json')[computeHash('Same words')]).toBe('Uno')
  })

  it('⭐ what `@` holds goes back whole, a translation’s mode with it', async () => {
    const content = { en: doc('Hello'), es: doc('Hola', 'Un parrafo mas'), '@': { es: { mode: 'custom' } } }
    pull(site(content))
    const back = await pushed()
    expect(back['@']).toEqual({ es: { mode: 'custom' } })
    expect(back.es.content).toHaveLength(2)
  })

  it('⭐ a language the site no longer lists keeps its document, and comes back when it is listed again', async () => {
    const translated = { en: doc('Hello', 'World'), es: doc('Hola', 'Mundo'), fr: doc('Bonjour', 'Monde') }
    pull(site(translated, ['en', 'es']))
    expect(existsSync(join(dir, 'locales/fr.json'))).toBe(false)
    expect(availableLocales(join(dir, 'locales'))).toEqual(['es'])
    const back = await pushed()
    expect(canonicalJson(back.fr)).toBe(canonicalJson(translated.fr))
    pull(site(translated))
    expect(read('fr.json')[computeHash('Hello')]).toBe('Bonjour')
    expect(existsSync(join(dir, 'locales/_kept.json'))).toBe(false)
  })

  it('CONTROL — a document with no `@` and no other language leaves nothing behind', () => {
    pull(site({ en: doc('Hello'), es: doc('Hola') }))
    expect(existsSync(join(dir, 'locales/_kept.json'))).toBe(false)
  })
})

// An article's body is the same field kind as a section's `content`, and the app keeps the same `@` for it.
describe('a record’s rich-text field keeps what the app keeps', () => {
  const dirs = []
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'in-step-record-'))
    dirs.push(d)
    return d
  }
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  const ARTICLE = {
    name: '@acme/article',
    sections: {
      article: {
        brief: true,
        fields: {
          title: { type: 'string', localized: true },
          body: { type: 'json', format: 'richtext', localized: true },
        },
      },
    },
  }
  const stored = (body) => ({ $uuid: 'U-hello', $schema: '@acme/article', article: { title: { en: 'Hello' }, body } })
  const folder = { contents: [{ kind: 'ref', name: 'hello', entry: { schema: '@acme/article', entity: 'U-hello' } }] }
  const edited = () => ({
    en: doc('Old words here today'),
    es: doc('Palabras viejas'),
    '@': { translations: { 'Old words here': { es: [text('Palabras viejas')] } } },
  })

  const pullInto = (dir, body) =>
    recordsToProject({
      folderDoc: folder,
      recordDocs: [stored(body)],
      siteRoot: dir,
      opts: { resolveDeclaration: () => ARTICLE, scope: '@acme' },
    })

  it('⭐ the row is recorded as outdated, and a push sends back the row and `@`', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'site.yml'), 'name: T\ndefaultLanguage: en\nlanguages: [en, es]\n')
    const report = pullInto(dir, edited())
    expect(report.skipped).toEqual([])
    const es = JSON.parse(readFileSync(join(dir, 'locales/records/es.json'), 'utf8'))
    const entry = es[computeHash('Old words here today')]
    expect(entry.default).toBe('Palabras viejas')
    expect(Object.values(entry.outdated)).toEqual(['Old words here'])
    const kept = JSON.parse(readFileSync(join(dir, 'locales/records/_kept.json'), 'utf8'))
    expect(Object.keys(kept)).toEqual(['article/hello#body'])
    expect(kept['article/hello#body']['@']).toEqual(edited()['@'])

    const declaration = ARTICLE
    const { entities } = recordsToEntities({
      label: 'article',
      records: [{ $id: 'hello', slug: 'hello', title: 'Hello', body: 'Old words here today' }],
      declaration,
      sourceLocale: 'en',
      translations: { es },
      kept,
    })
    const body = entities[0].document.article.body
    expect(body['@']).toEqual(edited()['@'])
    expect(body.es.content[0].content[0].text).toBe('Palabras viejas')
  })

  it('what is kept is no language of the records', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'locales/records'), { recursive: true })
    writeFileSync(join(dir, 'locales/records/es.json'), '{}')
    writeFileSync(join(dir, 'locales/records/_kept.json'), '{}')
    expect(await getRecordLocales(join(dir, 'locales'))).toEqual(['es'])
  })

  it('a record this pull did not read keeps what is kept for it', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'site.yml'), 'name: T\ndefaultLanguage: en\nlanguages: [en, es]\n')
    mkdirSync(join(dir, 'locales/records'), { recursive: true })
    writeFileSync(join(dir, 'locales/records/_kept.json'), JSON.stringify({ 'article/other#body': { '@': { es: { mode: 'custom' } } } }))
    pullInto(dir, edited())
    const kept = JSON.parse(readFileSync(join(dir, 'locales/records/_kept.json'), 'utf8'))
    expect(Object.keys(kept).sort()).toEqual(['article/hello#body', 'article/other#body'])
  })
})
