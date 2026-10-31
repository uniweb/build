/**
 * ⭐ A SOURCE EDIT IN A FILE KEEPS ITS TRANSLATION UNTIL SOMEONE REVIEWS IT, as one in the app does. Before
 * this the row fell back to the source at the next build or push, so an English typo fixed in a file put
 * English on every translated page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentRows, sectionsChangedSince, computeUnitHashes, siteContentDocumentToProject, siteProjectToDocument } from '../src/uwx/index.js'
import { extractManifest, formatKeptTranslations, formatSyncReport, keepEditedTranslations, rowsWantTranslation } from '../src/i18n/index.js'
import { carriedTranslations, manifestRows } from '../src/i18n/outdated.js'
import { isSmallEdit, wordOverlap } from '../src/i18n/word-overlap.js'
import { computeHash } from '../src/i18n/hash.js'
import { collectSiteContent } from '../src/site/index.js'
import { canonicalJson } from '../src/uwx/same-content.js'

const text = (value) => ({ type: 'text', text: value })
const paragraph = (value) => ({ type: 'paragraph', content: [text(value)] })
const doc = (...values) => ({ type: 'doc', content: values.map(paragraph) })
const h = computeHash
const PLACE = '/about:hero'

describe('wordOverlap', () => {
  it('is twice the words two texts share, over the words of both', () => {
    expect(wordOverlap('About PandaWatch', 'About PandaWatch today')).toBeCloseTo(0.8)
    expect(wordOverlap('Abuot Pandas', 'About Pandas')).toBe(0.5)
    expect(wordOverlap('Contact', 'Contact our sales team')).toBeCloseTo(0.4)
    expect(wordOverlap('Our story', 'What we do')).toBe(0)
    expect(wordOverlap('', '')).toBe(0)
  })

  // ⭐ What the editor flags, measured on 2026-10-31: a row pushed with its translation kept under the first
  // text, and read in the editor with the second as its source. The editor re-tests a row it reads, so these
  // are what `isSmallEdit` must say, or a row shows an old translation with no flag.
  const FLAGGED = [
    ['Leak detection', 'Leak detecton'],
    ['Hello World Again', 'hello world again'],
    ['Bathrooms', 'BATHROOMS'],
    ['Hello, world.', 'Hello world'],
    ['alpha beta gamma', 'alpha beta gamma delta epsilon zeta eta'],
    ['iota kappa lambda mu nu xi omicron', 'iota kappa lambda'],
    ['rho sigma', 'rho tau'],
    ['one two three four', 'one two five six'],
    ['ant bee cat dog elk', 'ant bee fox'],
    ['gnu hen ibis jay kite', 'gnu hen ibis'],
    ['call-outs daily', 'call outs daily'],
    ['same-day', 'same day service'],
    ["We're open today", 'We are open today'],
    ["We're closed", 'We are closed'],
    ['We’re open', 'We are open'],
    ['a an to', 'a an of'],
    ['of the and', 'of the but'],
    ['Price 10 now', 'Price 20 now'],
    ['2am call', '3am call'],
    ['red green blue pink', 'pink blue green red'],
    ['mint teal', 'teal mint'],
    ['один два', 'один три'],
    ['ένα δύο', 'ένα τρία'],
    ['水道 工事', '水道 修理'],
    ['snake_case word', 'snake case word'],
    ['Año único', 'Año nuevo'],
    ['Café abierto', 'Cafe abierto'],
    ['go go go', 'go go stop'],
    ['Plumbing that holds up.', 'Plumbing that really holds up.'],
    ['Same-day emergency call-outs', 'Same-day emergency callouts'],
    ['What we do', 'What we offer'],
    ['Request a quote', 'Request a free quote'],
  ]
  const NOT_FLAGGED = [
    ['Bathrooms', 'Bathroom'],
    ['upsilon phi chi', 'upsilon psi omega'],
    ['the the the cat', 'the dog'],
    ['no no no way', 'no thanks'],
    ['Protección rápida', 'Proteccion rapida'],
    ['水道工事の専門家', '水道工事の専門家です'],
    ['ash oak elm fir yew', 'ash oak bay box'],
    ['!!!', '???'],
    ['Landlord certificates', 'Annual paperwork for letting agents'],
  ]

  it.each(FLAGGED)('the editor flags %j → %j', (older, now) => {
    expect(isSmallEdit(older, now)).toBe(true)
  })

  it.each(NOT_FLAGGED)('the editor does not flag %j → %j', (older, now) => {
    expect(isSmallEdit(older, now)).toBe(false)
  })
})

describe('carriedTranslations', () => {
  const carry = (before, now, table) => carriedTranslations({ [PLACE]: before }, { [PLACE]: now }, table)

  it('⭐ a small edit keeps the translation, flagged with the text it was made from', () => {
    expect(carry(['About PandaWatch'], ['About PandaWatch today'], { [h('About PandaWatch')]: 'Acerca de PandaWatch' })).toEqual({
      [h('About PandaWatch today')]: { default: 'Acerca de PandaWatch', outdated: { [PLACE]: 'About PandaWatch' } },
    })
  })

  it('a rewrite keeps nothing', () => {
    expect(carry(['About PandaWatch'], ['Our whole story'], { [h('About PandaWatch')]: 'Acerca de PandaWatch' })).toEqual({})
  })

  it('a row with its own translation keeps it', () => {
    const table = { [h('About PandaWatch')]: 'Acerca de PandaWatch', [h('About PandaWatch today')]: 'Hoy' }
    expect(carry(['About PandaWatch'], ['About PandaWatch today'], table)).toEqual({})
  })

  it('CONTROL — an unchanged text keeps its own, and lends it to no other row', () => {
    const table = { [h('About PandaWatch')]: 'Acerca de PandaWatch' }
    expect(carry(['About PandaWatch'], ['About PandaWatch', 'About PandaWatch today'], table)).toEqual({})
  })

  it('nothing to keep where no language wrote anything: an empty value, or the source’s own that `init` starts with', () => {
    expect(carry(['Old words here'], ['Old words here today'], { [h('Old words here')]: '' })).toEqual({})
    expect(carry(['Old words here'], ['Old words here today'], { [h('Old words here')]: 'Old words here' })).toEqual({})
    expect(carry(['Old words here'], ['Old words here today'], { [h('Old words here')]: '*Old* words [here](/x)' })).toEqual({})
  })

  it('an empty value is no translation, so the row takes the one that went', () => {
    const table = { [h('Old words here')]: 'Palabras', [h('Old words here today')]: '' }
    expect(carry(['Old words here'], ['Old words here today'], table)).toEqual({
      [h('Old words here today')]: { default: 'Palabras', outdated: { [PLACE]: 'Old words here' } },
    })
  })

  it('each row takes the text most like it, whatever their order', () => {
    const before = ['Free shipping on all orders', 'Support by email or phone']
    const now = ['Support by email or chat', 'Free shipping on most orders']
    const table = { [h(before[0])]: 'Envío', [h(before[1])]: 'Soporte' }
    const added = carry(before, now, table)
    expect(added[h(now[0])].default).toBe('Soporte')
    expect(added[h(now[1])].default).toBe('Envío')
  })

  it('a text that has gone goes to one row: of a sentence split in two, the half most like it keeps it', () => {
    const before = ['One two three four']
    const now = ['One two three', 'One two three four five']
    const added = carry(before, now, { [h(before[0])]: 'Uno' })
    expect(Object.keys(added)).toEqual([h(now[1])])
  })

  it('a row twice in a section is one entry', () => {
    const added = carry(['Old words here'], ['Old words here today', 'Old words here today'], { [h('Old words here')]: 'Palabras' })
    expect(Object.keys(added)).toEqual([h('Old words here today')])
  })

  it('a place is read alone: an old text elsewhere lends nothing here', () => {
    const table = { [h('Old words here')]: 'Palabras' }
    expect(carriedTranslations({ '/other:hero': ['Old words here'] }, { [PLACE]: ['Old words here today'] }, table)).toEqual({})
  })

  it('a translation with overrides gives what it says in this place', () => {
    const table = { [h('Old words here')]: { default: 'Palabras', overrides: { [PLACE]: 'Aquí' } } }
    expect(carry(['Old words here'], ['Old words here today'], table)[h('Old words here today')].default).toBe('Aquí')
  })

  it('the same text in two places, from translations that differ, says each', () => {
    const table = { [h('Old words here')]: { default: 'Palabras', overrides: { '/b:x': 'Aquí' } } }
    const added = carriedTranslations(
      { '/a:x': ['Old words here'], '/b:x': ['Old words here'] },
      { '/a:x': ['Old words here today'], '/b:x': ['Old words here today'] },
      table,
    )
    expect(added[h('Old words here today')]).toEqual({
      default: 'Palabras',
      overrides: { '/b:x': 'Aquí' },
      outdated: { '/a:x': 'Old words here', '/b:x': 'Old words here' },
    })
  })

  it('an entry that names only other places keeps them', () => {
    const table = { [h('Old words here')]: 'Palabras', [h('Old words here today')]: { overrides: { '/b:x': 'Aquí' } } }
    expect(carry(['Old words here'], ['Old words here today'], table)[h('Old words here today')]).toEqual({
      overrides: { '/b:x': 'Aquí' },
      default: 'Palabras',
      outdated: { [PLACE]: 'Old words here' },
    })
  })

  it('a flagged translation edited again stays flagged, under the text that just went', () => {
    const table = { [h('Old words here today')]: { default: 'Palabras', outdated: { [PLACE]: 'Old words here' } } }
    expect(carry(['Old words here today'], ['Old words here today now'], table)[h('Old words here today now')]).toEqual({
      default: 'Palabras',
      outdated: { [PLACE]: 'Old words here today' },
    })
  })
})

describe('manifestRows', () => {
  it('takes a block element’s text, not a page’s title, a data block’s string or a picture’s words', () => {
    const units = {
      a: { source: 'A heading', field: 'title', contexts: [{ page: '/', section: 'hero' }] },
      b: { source: 'A heading two', field: 'heading.h2.1', contexts: [{ page: '/', section: 'hero' }] },
      c: { source: 'Some words', field: 'paragraph.2', contexts: [{ page: '/', section: 'hero' }, { page: '/b', section: 'x' }] },
      d: { source: 'An item', field: 'list.0', contexts: [{ page: '/', section: 'hero' }] },
      e: { source: 'A label', field: 'data.nav.0.label', contexts: [{ page: '/', section: 'hero' }] },
      f: { source: 'A picture', field: 'image', contexts: [{ page: '/', section: 'hero' }] },
      g: { source: 'A page', field: 'page.title', contexts: [{ page: '/', section: '_meta' }] },
      i: { source: 'A title shared', field: 'title', contexts: [{ page: '/', section: '_meta' }] },
    }
    expect(manifestRows({ units })).toEqual({
      '/:hero': ['A heading', 'A heading two', 'Some words', 'An item'],
      '/b:x': ['Some words'],
    })
  })

  it('no manifest, no rows', () => {
    expect(manifestRows(null)).toEqual({})
  })
})

describe('formatKeptTranslations', () => {
  it('says nothing of nothing', () => {
    expect(formatKeptTranslations({})).toEqual([])
    expect(formatKeptTranslations(undefined)).toEqual([])
  })

  it('says an edit once, with the languages it kept', () => {
    const pair = { was: 'Old', now: 'Old too' }
    const lines = formatKeptTranslations({ es: [pair], fr: [pair] })
    expect(lines[0]).toContain('1 edited string keeps its old translation')
    expect(lines[0]).toContain('es, fr')
    expect(lines[1]).toContain('"Old" → "Old too"')
    expect(lines[2]).toContain('plain string')
    expect(lines).toHaveLength(3)
  })
})

describe('a project on disk', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-keeps-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (path, body) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  const read = (name) => JSON.parse(readFileSync(join(dir, 'locales', name), 'utf8'))

  // A home page, and the page under test with one section, from files.
  const files = (heading = 'About PandaWatch', extra = '') => {
    write('site.yml', 'name: S\nfoundation: "@a/base"\ndefaultLanguage: en\nlanguages: [en, es, fr]\nindex: home\n')
    write('pages/home/page.yml', 'title: Home\n')
    write('pages/home/hero.md', '---\ntype: Hero\n---\n# Welcome\n')
    write('pages/about/page.yml', 'title: About\n')
    write('pages/about/hero.md', `---\ntype: Hero\n---\n# ${heading}\n\nSecond line\n${extra}`)
  }
  const contentIn = (document) => document.pages.find((page) => page.slug.en === 'about').page_sections[0].content
  const pushed = async () => contentIn(await siteProjectToDocument(dir))
  const manifest = async (options = {}) => extractManifest(dir, await collectSiteContent(dir), { ...options })

  describe('uniweb i18n sync', () => {
    beforeEach(async () => {
      files()
      await manifest()
      write('locales/es.json', { [h('About PandaWatch')]: 'Acerca de PandaWatch', [h('Second line')]: 'Segunda linea' })
      write('locales/fr.json', { [h('Second line')]: 'Seconde ligne' })
    })

    it('⭐ an edit keeps the old translation, flagged, in each language that had one', async () => {
      files('About PandaWatch today')
      const { report } = await manifest()
      const es = read('es.json')
      expect(es[h('About PandaWatch today')]).toEqual({ default: 'Acerca de PandaWatch', outdated: { [PLACE]: 'About PandaWatch' } })
      // The old entry stays: the same text coming back finds its translation.
      expect(es[h('About PandaWatch')]).toBe('Acerca de PandaWatch')
      expect(read('fr.json')[h('About PandaWatch today')]).toBeUndefined()
      expect(report.kept).toEqual({ es: [{ was: 'About PandaWatch', now: 'About PandaWatch today' }] })
      expect(formatSyncReport(report)).toContain('keeps its old translation')
    })

    it('a file’s other entries stay as written, and in their order', async () => {
      const before = '{\n  "zzzzzzzz": "Último",\n  "' + h('About PandaWatch') + '": "Acerca de PandaWatch",\n  "aaaaaaaa": { "default": "Primero" }\n}\n'
      writeFileSync(join(dir, 'locales/es.json'), before)
      files('About PandaWatch today')
      await manifest()
      const after = readFileSync(join(dir, 'locales/es.json'), 'utf8')
      expect(after.startsWith('{\n  "zzzzzzzz": "Último",\n  "' + h('About PandaWatch') + '": "Acerca de PandaWatch",\n  "aaaaaaaa": ')).toBe(true)
      expect(after.indexOf(h('About PandaWatch today'))).toBeGreaterThan(after.indexOf('aaaaaaaa'))
    })

    it('a dry run says what it would keep, and writes nothing', async () => {
      const before = readFileSync(join(dir, 'locales/es.json'), 'utf8')
      files('About PandaWatch today')
      const { report } = await manifest({ dryRun: true })
      expect(report.kept.es).toHaveLength(1)
      expect(readFileSync(join(dir, 'locales/es.json'), 'utf8')).toBe(before)
    })

    it('a sync that finds nothing writes nothing', async () => {
      const before = readFileSync(join(dir, 'locales/es.json'), 'utf8')
      const { report } = await manifest()
      expect(report.kept).toEqual({})
      expect(readFileSync(join(dir, 'locales/es.json'), 'utf8')).toBe(before)
    })

    it('a second sync of the same edit leaves the flag as it is', async () => {
      files('About PandaWatch today')
      await manifest()
      const before = readFileSync(join(dir, 'locales/es.json'), 'utf8')
      const { report } = await manifest()
      expect(report.kept).toEqual({})
      expect(readFileSync(join(dir, 'locales/es.json'), 'utf8')).toBe(before)
    })

    it('the same text coming back is its own translation again, and plain', async () => {
      files('About PandaWatch today')
      await manifest()
      files()
      const { report } = await manifest()
      expect(report.kept).toEqual({})
      expect(read('es.json')[h('About PandaWatch')]).toBe('Acerca de PandaWatch')
    })

    it('the file the source language has, if any, is no translation', async () => {
      write('locales/en.json', { [h('About PandaWatch')]: 'About' })
      files('About PandaWatch today')
      const { report } = await manifest()
      expect(report.kept.en).toBeUndefined()
      expect(read('en.json')[h('About PandaWatch today')]).toBeUndefined()
    })

    it('neither what a pull keeps nor the manifest is read as a language', async () => {
      write('locales/_kept.json', { [PLACE]: { '@': { es: { mode: 'custom' } } } })
      files('About PandaWatch today')
      const { report } = await manifest()
      expect(Object.keys(report.kept)).toEqual(['es'])
    })
  })

  it('CONTROL — a first extraction has nothing to compare, and keeps nothing', async () => {
    files('About PandaWatch today')
    write('locales/es.json', { [h('About PandaWatch')]: 'Acerca de PandaWatch' })
    const { report } = await manifest()
    expect(report.kept).toEqual({})
  })

  describe('a push', () => {
    const entry = { default: 'Acerca de PandaWatch', outdated: { [PLACE]: 'About PandaWatch' } }

    it('⭐ sends a flagged row with its entry in the map, as the app keeps it', async () => {
      files('About PandaWatch today')
      write('locales/es.json', { [h('About PandaWatch today')]: entry, [h('Second line')]: 'Segunda linea' })
      const content = await pushed()
      expect(content.es.content[0].content).toEqual([text('Acerca de PandaWatch')])
      expect(content['@']).toEqual({ translations: { 'About PandaWatch': { es: [text('Acerca de PandaWatch')] } } })
    })

    it('⭐ and the round trip is a fixed point: a pull writes the same entry, and a push sends the same document', async () => {
      files('About PandaWatch today')
      write('locales/es.json', { [h('About PandaWatch today')]: entry, [h('Second line')]: 'Segunda linea' })
      const document = await siteProjectToDocument(dir)
      const first = canonicalJson(contentIn(document))
      siteContentDocumentToProject({ siteRoot: dir, document })
      expect(read('es.json')[h('About PandaWatch today')]).toEqual(entry)
      expect(read('_kept.json')[PLACE]['@']).toEqual({ translations: { 'About PandaWatch': { es: [text('Acerca de PandaWatch')] } } })
      expect(canonicalJson(await pushed())).toBe(first)
    })

    it('⭐ a pull flags what the editor flags: a row kept under a text not like it is plain, and the map stays', async () => {
      files('Bathroom')
      write('locales/es.json', { [h('Bathroom')]: { default: 'Baños', outdated: { [PLACE]: 'Bathrooms' } } })
      const document = await siteProjectToDocument(dir)
      expect(contentIn(document)['@'].translations.Bathrooms.es).toEqual([text('Baños')])
      siteContentDocumentToProject({ siteRoot: dir, document })
      expect(read('es.json')[h('Bathroom')]).toBe('Baños')
      // And the round trip moves nothing: the entry is what the store holds, whatever the file says of it.
      expect(canonicalJson(await pushed())).toBe(canonicalJson(contentIn(document)))
    })

    it('a pull that finds a translation kept under two texts names the one most like the row', () => {
      files('Old words here today')
      const content = {
        en: doc('Old words here today'),
        es: doc('Palabras'),
        '@': { translations: { 'Old words': { es: [text('Palabras')] }, 'Old words here': { es: [text('Palabras')] }, 'Nothing like it': { es: [text('Palabras')] } } },
      }
      const document = {
        info: { name: { en: 'S' }, foundation: '@a/base' },
        settings: { default_language: 'en', languages: ['en', 'es'] },
        pages: [{ $id: 'about', slug: { en: 'about' }, mode: 'page', stable_id: 'about', title: { en: 'About' }, page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content }] }],
      }
      siteContentDocumentToProject({ siteRoot: dir, document })
      expect(read('es.json')[h('Old words here today')].outdated[PLACE]).toBe('Old words here')
    })

    it('CONTROL — a deleted row’s entry whose words a row happens to read is left: nothing it flags, and the text may return', async () => {
      files('Contact us')
      write('locales/es.json', { [h('Contact us')]: 'Contacto' })
      write('locales/_kept.json', { [PLACE]: { '@': { translations: { 'Get in touch with our team': { es: [text('Contacto')] } } } } })
      expect((await pushed())['@'].translations['Get in touch with our team'].es).toEqual([text('Contacto')])
    })

    it('adds to what a pull kept, and leaves what the app wrote as the app wrote it', async () => {
      files('About PandaWatch today')
      const stored = [{ type: 'text', text: 'Acerca de PandaWatch', marks: [{ type: 'bold' }] }]
      write('locales/es.json', { [h('About PandaWatch today')]: entry })
      write('locales/_kept.json', { [PLACE]: { '@': { es: { mode: 'x' }, translations: { 'Gone text': { es: [text('Ido')] }, 'About PandaWatch': { es: stored } } } } })
      const content = await pushed()
      expect(content['@'].es).toEqual({ mode: 'x' })
      expect(content['@'].translations['Gone text']).toEqual({ es: [text('Ido')] })
      expect(content['@'].translations['About PandaWatch'].es).toEqual(stored)
    })

    it('⭐ a flag taken out of the file is taken out of the map: the row was reviewed, and reads as it did', async () => {
      files('About PandaWatch today')
      write('locales/es.json', { [h('About PandaWatch today')]: 'Acerca de PandaWatch', [h('Second line')]: 'Segunda linea' })
      write('locales/_kept.json', { [PLACE]: { '@': { translations: { 'About PandaWatch': { es: [text('Acerca de PandaWatch')], fr: [text('À propos')] } } } } })
      const content = await pushed()
      expect(content.es.content[0].content).toEqual([text('Acerca de PandaWatch')])
      expect(content['@'].translations).toEqual({ 'About PandaWatch': { fr: [text('À propos')] } })
    })

    it('with nothing else there, the map goes and so does `@`', async () => {
      files('About PandaWatch today')
      write('locales/es.json', { [h('About PandaWatch today')]: 'Acerca de PandaWatch' })
      write('locales/_kept.json', { [PLACE]: { '@': { translations: { 'About PandaWatch': { es: [text('Acerca de PandaWatch')] } } } } })
      expect((await pushed())['@']).toBeUndefined()
    })

    it('a new translation leaves the old one in the map, where nothing reads it', async () => {
      files('About PandaWatch today')
      write('locales/es.json', { [h('About PandaWatch today')]: 'Acerca de PandaWatch hoy' })
      write('locales/_kept.json', { [PLACE]: { '@': { translations: { 'About PandaWatch': { es: [text('Acerca de PandaWatch')] } } } } })
      expect((await pushed())['@'].translations['About PandaWatch'].es).toEqual([text('Acerca de PandaWatch')])
    })

    it('CONTROL — a map’s entry a flagged row claims stays, though another row reads the same words', async () => {
      files('About PandaWatch today', '\nThird line\n')
      write('locales/es.json', { [h('About PandaWatch today')]: entry, [h('Third line')]: 'Acerca de PandaWatch' })
      const content = await pushed()
      expect(content['@'].translations['About PandaWatch'].es).toEqual([text('Acerca de PandaWatch')])
    })

    it('a row with no translation at all takes nothing out of the map', async () => {
      files('About PandaWatch today')
      write('locales/es.json', { [h('Second line')]: 'Segunda linea' })
      write('locales/_kept.json', { [PLACE]: { '@': { translations: { 'About PandaWatch': { es: [text('About PandaWatch today')] } } } } })
      expect((await pushed())['@'].translations['About PandaWatch'].es).toEqual([text('About PandaWatch today')])
    })

    it('a language written by hand has no rows of the file’s to flag', async () => {
      files('About PandaWatch today')
      write('locales/es.json', { [h('About PandaWatch today')]: entry })
      write('locales/freeform/es/pages/about/hero.md', 'Todo escrito a mano\n')
      const content = await pushed()
      expect(content.es.content[0].content[0].text).toBe('Todo escrito a mano')
      expect(content['@']).toBeUndefined()
    })

    it('CONTROL — with no flag and nothing kept, no `@`', async () => {
      files()
      write('locales/es.json', { [h('About PandaWatch')]: 'Acerca de PandaWatch' })
      expect('@' in (await pushed())).toBe(false)
    })
  })

  describe('what a push reads of a document', () => {
    const site = () => ({
      info: { name: { en: 'S' }, foundation: '@a/base' },
      settings: { default_language: 'en', languages: ['en', 'es'] },
      pages: [
        {
          $id: 'home',
          slug: { en: 'home' },
          is_index: true,
          mode: 'page',
          stable_id: 'home',
          title: { en: 'Home' },
          page_sections: [
            {
              $id: 'hero',
              stable_id: 'hero',
              type: 'Hero',
              content: { en: doc('Home words'), es: doc('Inicio') },
              $children: [{ $id: 'card', stable_id: 'card', type: 'Card', content: doc('Card words') }],
            },
          ],
          $children: [
            {
              $id: 'about',
              slug: { en: 'about' },
              mode: 'page',
              stable_id: 'about',
              title: { en: 'About' },
              page_sections: [{ $id: 'team', stable_id: 'team', type: 'Team', content: { en: doc('Team words', 'More words') } }],
            },
          ],
        },
      ],
      layout_sections: [{ $id: 'footer', stable_id: 'footer', layout_name: 'default', area: 'footer', type: 'Footer', content: { en: doc('Footer words') } }],
    })

    it('⭐ names each section by the place a push and a pull do', () => {
      expect(documentRows(site())).toEqual({
        '/:hero': ['Home words'],
        '/:card': ['Card words'],
        '/about:team': ['Team words', 'More words'],
        '/layout/footer:footer': ['Footer words'],
      })
    })

    it('reads the sections asked for', () => {
      const document = site()
      const team = document.pages[0].$children[0].page_sections[0]
      expect(Object.keys(documentRows(document, 'en', (record) => record === team))).toEqual(['/about:team'])
    })

    it('a place it names is where a pull writes an override: the same keys', () => {
      const document = site()
      const places = Object.keys(documentRows(document))
      document.pages[0].$children[0].page_sections[0].content = { en: doc('Team words', 'More words'), es: doc('Equipo', 'Más') }
      siteContentDocumentToProject({ siteRoot: dir, document })
      document.pages[0].$children[0].page_sections[0].content = {
        en: doc('Team words', 'More words'),
        es: doc('Equipo', 'Más'),
        '@': { translations: { 'Old team': { es: [text('Equipo')] } } },
      }
      siteContentDocumentToProject({ siteRoot: dir, document })
      expect(places).toContain(Object.keys(read('es.json')[h('Team words')].outdated)[0])
    })

    it('finds the sections this copy changed since a sync', () => {
      const document = site()
      const base = computeUnitHashes(document)
      expect(sectionsChangedSince(document, base).size).toBe(0)
      const team = document.pages[0].$children[0].page_sections[0]
      team.content = { en: doc('Team words changed') }
      expect([...sectionsChangedSince(document, base)]).toEqual([team])
    })

    it('a section the base does not name counts as changed', () => {
      expect(sectionsChangedSince(site(), {}).size).toBe(4)
    })
  })

  describe('whether a push has anything to look for', () => {
    beforeEach(() => {
      files()
      write('locales/es.json', { [h('Translated')]: 'Traducido', [h('Empty')]: '' })
    })

    it('a row every language has words for wants nothing', () => {
      expect(rowsWantTranslation(dir, { [PLACE]: ['Translated'] })).toBe(false)
    })

    it('a row with no words in a language wants them', () => {
      expect(rowsWantTranslation(dir, { [PLACE]: ['Not translated'] })).toBe(true)
      expect(rowsWantTranslation(dir, { [PLACE]: ['Empty'] })).toBe(true)
    })

    it('a site with no translation files wants nothing', () => {
      rmSync(join(dir, 'locales'), { recursive: true })
      expect(rowsWantTranslation(dir, { [PLACE]: ['Not translated'] })).toBe(false)
    })

    it('the source language’s own file is not asked', () => {
      rmSync(join(dir, 'locales/es.json'))
      write('locales/en.json', {})
      expect(rowsWantTranslation(dir, { [PLACE]: ['Not translated'] }, { sourceLocale: 'en' })).toBe(false)
    })

    it('keepEditedTranslations reads the old text it is given, from any record of it', () => {
      write('locales/es.json', { [h('Old words here')]: 'Palabras' })
      const kept = keepEditedTranslations(dir, { [PLACE]: ['Old words here'] }, { [PLACE]: ['Old words here today'] })
      expect(kept).toEqual({ es: [{ was: 'Old words here', now: 'Old words here today' }] })
      expect(read('es.json')[h('Old words here today')].default).toBe('Palabras')
      expect(existsSync(join(dir, 'locales/fr.json'))).toBe(false)
    })
  })
})
