// The record translation manifest — `locales/records/`, keyed by the RECORD.
//
// ⛔ THIS WAS THE DAY'S LEAST-COVERED CHANGE. The manifest's context shape moved
// from `{ collection, item }` — a QUERY name plus a slug — to `{ record }`, the
// record's own pool identity, and nothing tested the extract→translate round
// trip that has to agree on it. A key shape both sides derive independently is
// exactly where a mismatch produces no error: extraction writes one key,
// translation looks up another, and every string silently falls back to source.
//
// ⭐ AND THE RENAME WAS NOT COSMETIC. Keyed by the query, two queries over one
// schema produced two manifest entries for ONE record — each invisible from the
// other — and renaming a query orphaned every translation under it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractRecordContent,
  buildLocalizedRecords,
  translateRecordData,
} from '../../src/i18n/records.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
// Two queries over ONE schema — the case the old key got wrong.
const site = () => {
  w('site.yml', 'name: T\n')
  w('queries.yml', "recent:\n  schema: '@/article'\neverything:\n  schema: '@/article'\n")
  w('records.yml', '- article/*.md\n')
  w('records/article/hello.md', '---\ntitle: Hello\n---\n\nBody.\n')
  const item = { slug: 'hello', title: 'Hello there' }
  w('public/data/recent.json', [item])
  w('public/data/everything.json', [item])
}

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'record-manifest-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the manifest is keyed by the record', () => {
  it('contexts carry the record identity, not a query name', async () => {
    site()
    const manifest = await extractRecordContent(ROOT)
    const unit = Object.values(manifest.units).find((u) => u.source === 'Hello there')
    expect(unit).toBeTruthy()
    expect(unit.contexts).toEqual([{ record: 'article/hello' }])
    // ⛔ and never the old shape
    expect(unit.contexts[0]).not.toHaveProperty('collection')
    expect(unit.contexts[0]).not.toHaveProperty('item')
  })

  // ⭐ THE ASSERTION THE RENAME EXISTS FOR. One record reachable by two queries
  // is ONE translatable unit with ONE context — not two entries an author has to
  // translate twice and can find neither of from the other.
  it('two queries over one schema produce ONE context, not two', async () => {
    site()
    const manifest = await extractRecordContent(ROOT)
    const unit = Object.values(manifest.units).find((u) => u.source === 'Hello there')
    expect(unit.contexts).toHaveLength(1)
  })

  it('an org-scoped schema keys by its full pool path', async () => {
    w('site.yml', 'name: T\n')
    w('queries.yml', "people:\n  schema: '@std/person'\n")
    w('records.yml', '- std/person/ada.md\n')
    w('records/std/person/ada.md', '---\nname: Ada Lovelace\n---\n')
    w('public/data/people.json', [{ slug: 'ada', name: 'Ada Lovelace' }])

    const manifest = await extractRecordContent(ROOT)
    const unit = Object.values(manifest.units).find((u) => u.source === 'Ada Lovelace')
    expect(unit.contexts).toEqual([{ record: 'std/person/ada' }])
  })

  // ⛔ CONTROL. Every case above reads a context off a unit; without this, an
  // extractor that produced no units at all would pass none of them for the
  // right reason and all of them for the wrong one.
  it('CONTROL — extraction really produced units', async () => {
    site()
    const manifest = await extractRecordContent(ROOT)
    expect(Object.keys(manifest.units).length).toBeGreaterThan(0)
  })
})

describe('extract → translate agree on the key', () => {
  it('a translation written against the manifest actually lands', async () => {
    site()
    const manifest = await extractRecordContent(ROOT)
    const [hash] = Object.entries(manifest.units).find(([, u]) => u.source === 'Hello there')

    // The locale file the author would write, keyed by the manifest's own hash.
    w(`locales/records/es.json`, { [hash]: 'Hola a todos' })

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    expect(outputs.es).toBeTruthy()
    const translated = JSON.parse(readFileSync(outputs.es.recent, 'utf8'))
    // ⚠️ THE WHOLE POINT: if extraction and translation derived the key
    // differently, this silently stays 'Hello there' with no error anywhere.
    expect(translated[0].title).toBe('Hola a todos')
  })

  it('the manifest lives at locales/records/, not locales/collections/', async () => {
    site()
    const manifest = await extractRecordContent(ROOT)
    const [hash] = Object.entries(manifest.units).find(([, u]) => u.source === 'Hello there')
    w('locales/records/es.json', { [hash]: 'Hola' })
    // a file at the OLD path is not consulted
    w('locales/collections/es.json', { [hash]: 'WRONG' })

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    expect(JSON.parse(readFileSync(outputs.es.recent, 'utf8'))[0].title).toBe('Hola')
  })
})

// ⛔ A FAILURE IN THIS LANE MUST REACH THE CALLER, not only stderr.
//
// A `ReferenceError` here — a programming error, not bad data — was caught by a
// handler meant for an unparseable file, downgraded to `console.warn`, and the
// locale's output silently omitted. The build stayed green while nothing was
// translated, and that is how the scoping bug above survived being written.
describe('a translation failure is reported, not only logged', () => {
  it('surfaces the file and locale that failed', async () => {
    site()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    w('public/data/broken.json', '[{"slug": "x", ')  // truncated JSON

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    expect(outputs.failures).toBeTruthy()
    expect(outputs.failures[0]).toMatchObject({ locale: 'es', file: 'broken.json' })
    expect(err).toHaveBeenCalled()

    // ⛔ CONTROL — one bad file does not take the rest down. A multi-locale build
    // that aborted on any parse error would be worse than the silence it replaced.
    expect(outputs.es.recent).toBeTruthy()
    err.mockRestore()
  })

  it('CONTROL — a clean run reports no failures at all', async () => {
    site()
    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    expect(outputs.failures).toBeUndefined()
  })
})

// ⭐ THE DEV SERVER'S PATH — `/es/data/<query>.json` is translated on request by
// `translateRecordData`. ⛔ It threw a `ReferenceError` (`recordDir` was never defined
// there) whenever `locales/freeform/<locale>/` existed, and the middleware caught it and
// let the request fall through untranslated. Beneath it, both lanes handed the free-form loader
// the record's POOL DIRECTORY where it takes a schema ref, so a free-form record file
// was never found — on the dev server or in a localized build.
describe('free-form and hash-based record translation agree on the record, in dev and in a build', () => {
  const freeformSite = async () => {
    site()
    w('public/data/recent.json', [{ slug: 'hello', title: 'Hello there' }, { slug: 'world', title: 'World news' }])
    w('locales/freeform/es/records/article/hello.md', '---\ntitle: Hola (libre)\n---\n\nCuerpo libre.\n')
    const manifest = await extractRecordContent(ROOT)
    const hashOf = (source) => Object.entries(manifest.units).find(([, u]) => u.source === source)[0]
    // An override keyed by the RECORD (`article/world`), which the default must not win over
    return { [hashOf('World news')]: { default: 'Noticias', overrides: { 'article/world': 'Noticias del mundo' } } }
  }
  const textOf = (doc) => JSON.stringify(doc).match(/"text":"([^"]*)"/)?.[1]

  it('translateRecordData — free-form enabled: the free-form record applies, and the hash-based one keys by the record', async () => {
    const translations = await freeformSite()
    const items = JSON.parse(readFileSync(join(ROOT, 'public/data/recent.json'), 'utf8'))
    const out = await translateRecordData(items, 'recent', ROOT, {
      locale: 'es', localesDir: join(ROOT, 'locales'), translations, freeformEnabled: true,
    })
    expect(out[0].title).toBe('Hola (libre)')
    expect(textOf(out[0].content)).toBe('Cuerpo libre.')
    expect(out[1].title).toBe('Noticias del mundo')
  })

  it('translateRecordData — free-form off: the hash-based record key is the record\'s, not the query\'s', async () => {
    const translations = await freeformSite()
    const items = JSON.parse(readFileSync(join(ROOT, 'public/data/recent.json'), 'utf8'))
    const out = await translateRecordData(items, 'recent', ROOT, { locale: 'es', translations, freeformEnabled: false })
    expect(out[1].title).toBe('Noticias del mundo')
    // CONTROL — without free-form, the free-form file is not read
    expect(out[0].title).toBe('Hello there')
  })

  it('buildLocalizedRecords reads the same free-form record', async () => {
    const translations = await freeformSite()
    w('locales/records/es.json', translations)
    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const translated = JSON.parse(readFileSync(outputs.es.recent, 'utf8'))
    expect(translated[0].title).toBe('Hola (libre)')
    expect(translated[1].title).toBe('Noticias del mundo')
  })
})

// ⛔ A RECORD'S SYSTEM FIELDS ARE NOT PROSE. A compiled record carries `$name` (the handle
// a parametric page's URL names) and `path` (its placement in records.yml) beside its
// data, and both were extracted as translatable text — and translated, so a Spanish
// build could rewrite a handle and the record's page stopped matching its URL.
describe('system fields are never extracted, nor translated', () => {
  const units = (manifest) => Object.values(manifest.units).map((u) => u.source)

  it('heuristic: `$`-prefixed keys at any depth, and the top-level `slug` and `path`', async () => {
    site()
    w('public/data/recent.json', [
      { slug: 'hello-post', $name: 'hello-post', path: 'archive', title: 'Hello there', credit: { $id: 'credit-1', label: 'Photo by Ada' } },
    ])
    const sources = units(await extractRecordContent(ROOT))
    expect(sources).not.toContain('hello-post')
    expect(sources).not.toContain('archive')
    expect(sources).not.toContain('credit-1')
    // CONTROL — the record's prose, top-level and nested, is extracted
    expect(sources).toEqual(expect.arrayContaining(['Hello there', 'Photo by Ada']))
  })

  it('schema-guided: a schema that declares `slug` a plain string does not make the handle prose', async () => {
    // `events` resolves `@uniweb/schemas`' flat `event` schema, whose `slug` is `type: string`
    w('site.yml', 'name: T\n')
    w('public/data/events.json', [{ slug: 'launch-day', $name: 'launch-day', path: 'archive', title: 'Launch Day' }])
    const sources = units(await extractRecordContent(ROOT))
    expect(sources).not.toContain('launch-day')
    expect(sources).not.toContain('archive')
    expect(sources).toContain('Launch Day')
  })

  it('a translation whose source equals a handle rewrites the prose and leaves the handle', async () => {
    w('site.yml', 'name: T\n')
    w('queries.yml', "recent:\n  schema: '@/article'\n")
    w('public/data/recent.json', [{ slug: 'welcome', $name: 'welcome', path: 'welcome', title: 'welcome' }])
    w('public/data/events.json', [{ slug: 'welcome', $name: 'welcome', title: 'welcome' }])
    const manifest = await extractRecordContent(ROOT)
    const [hash] = Object.entries(manifest.units).find(([, u]) => u.source === 'welcome')
    w('locales/records/es.json', { [hash]: 'bienvenida' })

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const [article] = JSON.parse(readFileSync(outputs.es.recent, 'utf8'))
    expect(article).toMatchObject({ title: 'bienvenida', slug: 'welcome', $name: 'welcome', path: 'welcome' })
    const [event] = JSON.parse(readFileSync(outputs.es.events, 'utf8'))
    expect(event).toMatchObject({ title: 'bienvenida', slug: 'welcome', $name: 'welcome' })
  })
})
