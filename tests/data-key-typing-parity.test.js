/**
 * ⭐ A QUERY A DATA KEY TYPES CARRIES ONE SCHEMA ON BOTH LANES (2026-10-08).
 *
 * `articles:` declares no schema, its records sit in `records/articles/`, no data schema is
 * named `articles`, and a section type declares `data: { articles: '@/post' }` — so its records
 * are `@/post` records (ruled 2026-09-25 [Diego]). A push names the query `@/post`; until
 * 2026-10-08 the static payload named it `@/articles`, so a key typed `@/post` that is not named
 * `articles` filled on a hosted site and stayed empty on a static one — and a query of `@/post`
 * read none of those records on a static site, where a host answers it with all of them.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaredKeys, fillDeclaredKeys, sameSchema } from '@uniweb/core'
import { collectSiteContent } from '../src/site/content-collector.js'
import { processQueries } from '../src/site/query-processor.js'
import { emitSyncPackages, readZip } from '../src/uwx/index.js'
import { buildSchema } from '../src/schema.js'

let ROOT, SITE, FDN
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uw-key-typing-'))
  SITE = join(ROOT, 'site')
  FDN = join(ROOT, 'fdn')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

// A store-like site on a local foundation `@acme/fnd`: JournalList types the key `articles` as
// `@/post`, and Article reads one post under a key named for no query.
async function makeSite(queriesYml = 'articles:\n  sort: title\n') {
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/queries.yml', queriesYml)
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/records/articles/hello.md', '---\ntitle: Hello\n---\n\nThe body.\n')
  w('site/records/articles/world.md', '---\ntitle: World\n---\n\nMore.\n')
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  w('fdn/schemas/post.yml', 'name: post\nfields:\n  title: string\n  content: markdown\n')
  w('fdn/sections/JournalList/meta.js', "export default { data: { articles: '@/post' } }\n")
  w('fdn/sections/JournalList/index.jsx', 'export default function JournalList() { return null }\n')
  w('fdn/sections/Article/meta.js', "export default { data: { article: { schema: '@/post', single: true } } }\n")
  w('fdn/sections/Article/index.jsx', 'export default function Article() { return null }\n')
  // What a build writes, and a push reads its section types from.
  w('fdn/dist/meta/schema.json', await buildSchema(FDN))
}

const payloadQueries = async () => (await collectSiteContent(SITE, { foundationPath: FDN })).config.queries
const wireQuery = async (name) => {
  const pkg = await emitSyncPackages(SITE, { backend: 'http://backend.test' })
  const doc = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
  return doc.queries.find((q) => q.name === name)
}
const ARTICLE = declaredKeys({ article: { schema: '@/post', single: true } })

describe('a query a data key types — one schema on both lanes', () => {
  it('⭐ the static payload names the type, as a push names it', async () => {
    await makeSite()
    const staticSchema = (await payloadQueries()).articles.schema
    expect(staticSchema).toBe('@/post')
    const wire = (await wireQuery('articles')).schema
    expect(wire).toBe('@acme/post')
    expect(sameSchema(staticSchema, wire)).toBe(true)
  })

  it('⭐ so a key typed by it fills from the query by schema on a static payload', async () => {
    await makeSite()
    const queries = await payloadQueries()
    const fills = fillDeclaredKeys(ARTICLE, [{ query: 'articles', as: 'articles' }], { queries })
    expect([...fills.keys()]).toEqual(['article'])
    // CONTROL — under the name the payload carried until 2026-10-08, nothing fills it
    const before = fillDeclaredKeys(ARTICLE, [{ query: 'articles', as: 'articles' }], { queries: { articles: { schema: '@/articles' } } })
    expect([...before.keys()]).toEqual([])
  })

  it('the static build still reads the query\'s records from its own folder', async () => {
    await makeSite()
    const byQuery = await processQueries(SITE, await payloadQueries(), undefined, '/')
    expect(byQuery.articles.map((r) => r.$name)).toEqual(['hello', 'world'])
    // and in the type's shape — `content` holds the markdown body, as the schema declares it
    expect(byQuery.articles[0].content).toBeDefined()
  })

  it('⭐ a query of the type reads those records too, as a host answers it', async () => {
    await makeSite('articles: {}\nposts:\n  schema: "@/post"\n  sort: title\n')
    const byQuery = await processQueries(SITE, await payloadQueries(), undefined, '/')
    expect(byQuery.posts.map((r) => r.$name)).toEqual(['hello', 'world'])
    expect(byQuery.articles.map((r) => r.$name).sort()).toEqual(['hello', 'world'])
  })

  it('CONTROL — a query that asks for `@/articles` explicitly keeps it, on the payload and the records', async () => {
    await makeSite('articles:\n  schema: "@/articles"\n')
    const queries = await payloadQueries()
    expect(queries.articles.schema).toBe('@/articles')
    const byQuery = await processQueries(SITE, queries, undefined, '/')
    expect(byQuery.articles.map((r) => r.$name).sort()).toEqual(['hello', 'world'])
  })
})
