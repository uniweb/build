/**
 * Every language of a site but its default (`i18n/index.js::buildLocalizedSite`): its records, then
 * its content, then — on the bundle lane — its projections, made from both.
 *
 * ⛔ Until 2026-10-25 a build ran content, then records, and wrote a language's search index inside
 * the content step: from its pages alone, before its records were translated. Measured on a starter
 * in three languages, the default language's index held 20 entries and each other one 17 — none of
 * the site's 3 record pages — and no language but the default got an `llms.txt` or a `.md`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { processQueries, writeQueryFiles } from '../../src/site/query-processor.js'
import { extractRecordContent } from '../../src/i18n/records.js'
import { buildLocalizedContent, buildLocalizedSite } from '../../src/i18n/index.js'

let ROOT
let saved
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel) => existsSync(join(ROOT, rel))
const section = (markdown) => ({ id: 0, type: 'Section', params: {}, content: markdownToProseMirror(markdown), subsections: [] })

/** A site with an article in English and Spanish, built as far as the bundle builds it. */
async function bundledSite() {
  w('site.yml', 'name: T\ndefaultLanguage: en\nlanguages: [en, es]\n')
  w('queries.yml', "recent:\n  schema: '@/article'\n")
  w('records/article/hello.md', '---\ntitle: Hello there\n---\n\nThe body of the article.\n')
  const queries = { recent: { schema: '@/article' } }
  await writeQueryFiles(ROOT, await processQueries(ROOT, queries, undefined, '/'), queries)
  // What the bundle writes for the default language (`site/plugin.js`).
  w('dist/site-content.json', {
    config: {
      name: 'T',
      defaultLanguage: 'en',
      languages: ['en', 'es'],
      search: true,
      queries,
      i18n: { routeTranslations: { es: { '/blog': '/noticias' } } }
    },
    pages: [
      { route: '/', title: 'Home', hasContent: true, sections: [section('# Home\n\nWelcome.')] },
      {
        route: '/blog',
        title: 'Blog',
        hasContent: true,
        fetch: { query: 'recent', path: '/data/recent.json', as: 'recent' },
        sections: [section('# Blog\n\nThe latest.')]
      },
      { route: '/blog/:slug', parent: '/blog', isDynamic: true, title: 'Article', sections: [] }
    ]
  })
  const manifest = await extractRecordContent(ROOT)
  const hashOf = (source) => Object.entries(manifest.units).find(([, unit]) => unit.source === source)?.[0]
  w('locales/records/es.json', {
    [hashOf('Hello there')]: 'Hola a todos',
    [hashOf('The body of the article.')]: 'El cuerpo del artículo.'
  })
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'localized-site-'))
  saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
})
afterEach(() => {
  ;[console.log, console.warn] = saved
  rmSync(ROOT, { recursive: true, force: true })
})

describe('buildLocalizedSite', () => {
  it('⭐ a language\'s search index and agent files list its records, in its language', async () => {
    await bundledSite()
    const built = await buildLocalizedSite(ROOT, { locales: ['es'], projections: true })
    expect(built.records.failures).toBeUndefined()

    const index = JSON.parse(read('dist/es/search-index.json'))
    expect(index.entries.filter((entry) => entry.type === 'record').map((entry) => [entry.route, entry.title])).toEqual([
      ['/blog/hello', 'Hola a todos']
    ])
    expect(read('dist/es/llms.txt')).toContain('[Hola a todos](/es/noticias/hello.md)')
    expect(read('dist/es/noticias/hello.md')).toContain('El cuerpo del artículo.')
    expect(built.projections.es.map((file) => file.fileName)).toContain('es/noticias/hello.md')
  })

  it('the default language is the root tree: nothing is written under its code', async () => {
    await bundledSite()
    await buildLocalizedSite(ROOT, { locales: ['en', 'es'], projections: true })
    expect(has('dist/es/site-content.json')).toBe(true)
    expect(has('dist/en')).toBe(false)
  })

  it('without projections — the link lane — a language gets its content and records, and no projection', async () => {
    await bundledSite()
    await buildLocalizedSite(ROOT, { locales: ['es'] })
    expect(has('dist/es/site-content.json')).toBe(true)
    expect(JSON.parse(read('dist/es/data/recent.json'))[0].title).toBe('Hola a todos')
    for (const file of ['dist/es/search-index.json', 'dist/es/llms.txt', 'dist/es/index.md']) expect(has(file)).toBe(false)
  })
})

describe('buildLocalizedContent', () => {
  it('⛔ writes no search index, and says where one comes from to a caller that asks for it', async () => {
    await bundledSite()
    await expect(buildLocalizedContent(ROOT, { locales: ['es'], generateSearchIndexes: true })).rejects.toThrow(/buildLocalizedSite/)
    await buildLocalizedContent(ROOT, { locales: ['es'] })
    expect(has('dist/es/site-content.json')).toBe(true)
    expect(has('dist/es/search-index.json')).toBe(false)
  })
})
