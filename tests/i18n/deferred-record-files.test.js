/**
 * A query with `deferred:` fields writes each record whole to `/data/<query>/<slug>.json`
 * beside its lean list — and a localized build translates those files with the same
 * record translations the list gets.
 *
 * ⛔ Until 2026-09-14 `buildLocalizedRecords` translated the list files alone, and
 * `extractRecordContent` read the list files alone. The list is where a deferred field
 * is NOT — it is stripped there — so an article's body was neither extracted from a
 * site whose `deferred:` was derived, nor translated from a manifest that held it:
 * measured on the `international` template, Spanish article pages showed English bodies
 * under a Spanish list.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processQueries, writeQueryFiles } from '../../src/site/query-processor.js'
import { extractRecordContent, buildLocalizedRecords, translateRecordData } from '../../src/i18n/records.js'
import { siteContentPlugin } from '../../src/site/plugin.js'

let ROOT
let saved
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
const textOf = (doc) => [...JSON.stringify(doc).matchAll(/"text":"([^"]*)"/g)].map((m) => m[1])

/** A site whose `recent` query defers its records' bodies, compiled as a build compiles it. */
async function compiledSite() {
  w('site.yml', 'name: T\n')
  const queries = { recent: { schema: '@/article', deferred: ['content'] } }
  w('queries.yml', "recent:\n  schema: '@/article'\n  deferred: [content]\n")
  w('records.yml', '- article/*.md\n')
  // A heading, so the body holds a string the list's auto-excerpt does not
  w('records/article/hello.md', '---\ntitle: Hello there\n---\n\n## A heading\n\nThe body of the article.\n')
  const byQuery = await processQueries(ROOT, queries, undefined, '/')
  await writeQueryFiles(ROOT, byQuery, queries)
}

/** The Spanish record translations, keyed by the manifest's own hashes. */
async function spanish() {
  const manifest = await extractRecordContent(ROOT)
  const hashOf = (source) => Object.entries(manifest.units).find(([, u]) => u.source === source)?.[0]
  return {
    [hashOf('Hello there')]: 'Hola a todos',
    [hashOf('A heading')]: 'Un encabezado',
    [hashOf('The body of the article.')]: 'El cuerpo del artículo.',
  }
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'deferred-record-files-'))
  saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
})
afterEach(() => {
  ;[console.log, console.warn] = saved
  rmSync(ROOT, { recursive: true, force: true })
})

describe('a deferred query\'s per-record files', () => {
  it('CONTROL — the build writes a lean list and a whole record', async () => {
    await compiledSite()
    expect(read('public/data/recent.json')[0]).not.toHaveProperty('content')
    expect(textOf(read('public/data/recent/hello.json').content)).toEqual(['A heading', 'The body of the article.'])
  })

  it('extraction reads them — a deferred field\'s strings reach the manifest', async () => {
    await compiledSite()
    const manifest = await extractRecordContent(ROOT)
    // (the paragraph would also arrive through the list's auto-excerpt; the heading only from the body)
    const unit = Object.values(manifest.units).find((u) => u.source === 'A heading')
    expect(unit).toBeTruthy()
    // one record, one context — the list and the record file are the same record
    const title = Object.values(manifest.units).find((u) => u.source === 'Hello there')
    expect(title.contexts).toEqual([{ record: 'article/hello' }])
  })

  it('the localized build translates them with the list\'s translations, beside the translated list', async () => {
    await compiledSite()
    w('locales/records/es.json', await spanish())
    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    expect(outputs.failures).toBeUndefined()

    expect(read('dist/es/data/recent.json')[0].title).toBe('Hola a todos')
    const record = read('dist/es/data/recent/hello.json')
    expect(record.title).toBe('Hola a todos')
    expect(textOf(record.content)).toEqual(['Un encabezado', 'El cuerpo del artículo.'])
    // CONTROL — the default locale's record file is the source, untouched
    expect(textOf(read('public/data/recent/hello.json').content)).toEqual(['A heading', 'The body of the article.'])
  })

  it('a free-form record translation reaches the record file too', async () => {
    await compiledSite()
    w('locales/freeform/es/records/article/hello.md', '---\ntitle: Hola (libre)\n---\n\nCuerpo libre.\n')
    await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const record = read('dist/es/data/recent/hello.json')
    expect(record.title).toBe('Hola (libre)')
    expect(textOf(record.content)).toEqual(['Cuerpo libre.'])
  })

  it('a record file removed from the source is not left translated in the locale', async () => {
    await compiledSite()
    w('dist/es/data/recent/gone.json', { slug: 'gone', title: 'Stale' })
    await buildLocalizedRecords(ROOT, { locales: ['es'] })
    expect(existsSync(join(ROOT, 'dist/es/data/recent/gone.json'))).toBe(false)
    expect(existsSync(join(ROOT, 'dist/es/data/recent/hello.json'))).toBe(true)
  })
})

describe('the dev server translates a record file on request, as it does a list', () => {
  it('translateRecordData takes one record as well as a list', async () => {
    await compiledSite()
    const translations = await spanish()
    const one = await translateRecordData(read('public/data/recent/hello.json'), 'recent', ROOT, { locale: 'es', translations })
    expect(one.title).toBe('Hola a todos')
    expect(textOf(one.content)).toEqual(['Un encabezado', 'El cuerpo del artículo.'])
  })

  it('`/es/data/recent/hello.json` is served translated', async () => {
    await compiledSite()
    const translations = await spanish()
    const plugin = siteContentPlugin({ sitePath: './', watch: false })
    await plugin.configResolved({ root: ROOT, publicDir: join(ROOT, 'public'), build: { outDir: 'dist' }, command: 'serve', base: '/' })
    await plugin.buildStart()
    let middleware
    plugin.configureServer({ ws: { send: () => {} }, middlewares: { use: (fn) => { middleware = fn } } })
    // Written after the server starts, so it opens no translation watcher this test would leave behind
    w('locales/records/es.json', translations)

    const serve = (url) => new Promise((done) => {
      const res = { setHeader: () => {}, end: (body) => done(JSON.parse(body)) }
      middleware({ url }, res, () => done(null))
    })
    const record = await serve('/es/data/recent/hello.json')
    expect(record?.title).toBe('Hola a todos')
    expect(textOf(record.content)).toEqual(['Un encabezado', 'El cuerpo del artículo.'])
    // CONTROL — the list is served translated, as it already was
    expect((await serve('/es/data/recent.json'))[0].title).toBe('Hola a todos')
  })
})
