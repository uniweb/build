/**
 * An external query — a named query with `url:` — ruled 2026-09-13 [Diego]: *"Setting
 * `url` would classify it as external, and `transform` is a powerful concept."* It
 * replaces the inline `fetch: { url: … }` a section used to carry, so every external
 * source a site reads is listed in one file.
 *
 * Measured before: a query's `url:` compiled to no records with no request; `method`
 * and `body` did not survive the build; a record request reused the list's
 * `transform`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { resolveFetchConfigs } from '@uniweb/core'
import { resolveQueriesConfig, refuseQueryDeclaration } from '../src/site/queries-config.js'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'
import { executeFetch, parseFetchConfig } from '../src/site/data-fetcher.js'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument, declarationsToQueriesYml } from '../src/uwx/index.js'

const refuse = (decl) => () => refuseQueryDeclaration({ name: 'items', ...decl })

describe('what an external query may declare', () => {
  it('accepts url, method, body, transform, where, sort, limit, record and queryable', () => {
    expect(refuse({
      url: 'https://api.test/items', method: 'post', body: { q: 1 }, transform: 'data.items',
      where: { a: 1 }, sort: 'date desc', limit: 3,
      record: { url: 'https://api.test/items/{slug}', method: 'GET', body: { id: '{slug}' }, transform: 'data' },
      queryable: { a: { type: 'boolean' } },
    })).not.toThrow()
  })

  it('⛔ refuses what describes the site\'s records beside `url:`', () => {
    expect(refuse({ url: 'https://api.test/items', schema: '@/item' })).toThrow(/query "items": `schema:` describes the site's records, and this query has `url:`/)
    expect(refuse({ url: 'https://api.test/items', scope: 'a', deferred: ['body'] })).toThrow(/`scope:`, `deferred:` describe the site's records/)
    for (const key of ['excerpt', 'path']) {
      expect(refuse({ url: 'https://api.test/items', [key]: 'x' })).toThrow(/describes the site's records/)
    }
  })

  it('⛔ `route:` is retired on every query — a record links to its query\'s page as `$route`', () => {
    expect(refuse({ schema: '@/item', route: '/items' })).toThrow(/`route:` is retired\..*\$route.*detailPage/s)
    expect(refuse({ url: 'https://api.test/items', route: '/items' })).toThrow(/`route:` is retired/)
  })

  it('⛔ `detailUrl:` is retired everywhere — its case is `record.url`', () => {
    expect(refuse({ schema: '@/item', deferred: ['body'], detailUrl: '/api/{slug}' })).toThrow(/`detailUrl:` is retired\. .*record: \{ url: … \}/)
    expect(refuse({ url: 'https://api.test/items', detailUrl: '/api/{slug}' })).toThrow(/`detailUrl:` is retired/)
  })

  it('⛔ `detail:` is retired on a query too — an API\'s single-record request is `record:`', () => {
    // It was accepted in silence and carried into `config.queries`, where nothing read it.
    expect(refuse({ schema: '@/item', detail: '/data/items/{slug}.json' })).toThrow(/query "items": `detail:` is retired\. .*`record: \{ url: … \}` on an external query — one with `url:`/)
    expect(refuse({ url: 'https://api.test/items', detail: 'rest' })).toThrow(/`detail:` is retired/)
  })

  it('⛔ an external source\'s keys on a query with no `url:`', () => {
    for (const key of ['method', 'body', 'transform', 'record']) {
      expect(refuse({ schema: '@/item', [key]: 'x' })).toThrow(new RegExp(`\`${key}:\` belongs on an external query — one with \`url:\``))
    }
  })

  it('⛔ a record request of another shape, and a method other than GET or POST', () => {
    expect(refuse({ url: 'https://api.test/items', record: { url: 'x', headers: {} } })).toThrow(/`record:` takes `url`, `method`, `body`, `transform` — not `headers`/)
    expect(refuse({ url: 'https://api.test/items', record: 'https://api.test/items/{slug}' })).toThrow(/`record:` is the request for one record/)
    expect(refuse({ url: 'https://api.test/items', method: 'PUT' })).toThrow(/`method: "PUT"` — an external query is read with `GET` or `POST`/)
    expect(refuse({ url: '' })).toThrow(/`url:` is the external source's address/)
  })

  it('`detail:` in queries.yml stops the build and the sync push — so `config.queries` never carries it — and a pull does not write a stored one back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'external-queries-detail-'))
    try {
      writeFileSync(join(root, 'site.yml'), 'name: T\nfoundation: "@acme/base@1.0.0"\n')
      writeFileSync(join(root, 'queries.yml'), "items:\n  schema: '@/item'\n  detail: rest\n")
      await expect(resolveQueriesConfig(root)).rejects.toThrow(/query "items": `detail:` is retired/)
      await expect(collectSiteContent(root, { strict: true })).rejects.toThrow(/`detail:` is retired/)
      await expect(siteProjectToDocument(root)).rejects.toThrow(/`detail:` is retired/)

      rmSync(join(root, 'queries.yml'))
      declarationsToQueriesYml({ document: { queries: [{ name: 'items', schema: '@/other', detail: 'rest', limit: 3 }] }, siteRoot: root })
      const written = yaml.load(readFileSync(join(root, 'queries.yml'), 'utf8'))
      expect(written.items).toEqual({ schema: '@/other', limit: 3 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the build and the sync push both refuse, through the one resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'external-queries-'))
    writeFileSync(join(root, 'site.yml'), 'name: T\nfoundation: "@acme/base@1.0.0"\n')
    writeFileSync(join(root, 'queries.yml'), "items:\n  url: https://api.test/items\n  schema: '@/item'\n")
    await expect(resolveQueriesConfig(root)).rejects.toThrow(/describes the site's records/)
    await expect(siteProjectToDocument(root)).rejects.toThrow(/describes the site's records/)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('an external query compiles nothing', () => {
  it('no `/data/<name>.json` stands in for a live source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'external-compile-'))
    mkdirSync(join(root, 'records', 'post'), { recursive: true })
    writeFileSync(join(root, 'records', 'post', 'a.md'), '---\ntitle: A\n---\n\nA\n')
    const queries = { items: { url: 'https://api.test/items' }, posts: { schema: '@/post' } }
    const saved = console.log
    console.log = () => {}
    try {
      const byQuery = await processQueries(root, queries)
      expect(Object.keys(byQuery)).toEqual(['posts'])
      await writeQueryFiles(root, byQuery, queries)
    } finally {
      console.log = saved
    }
    expect(existsSync(join(root, 'public', 'data', 'posts.json'))).toBe(true)
    expect(existsSync(join(root, 'public', 'data', 'items.json'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('a binding of an external query, read at build when it asks to be', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs its body and unwraps by its transform — `method` and `body` survive the build', async () => {
    const calls = []
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ data: { items: [{ id: 2, n: 2 }, { id: 1, n: 1 }] } }) }
    })
    const queries = { items: { url: 'https://api.test/graphql', method: 'POST', body: { query: '{ items }' }, transform: 'data.items', sort: 'n asc' } }
    const cfg = resolveFetchConfigs([parseFetchConfig({ query: 'items', prerender: true })], { queries }).get('items')
    const result = await executeFetch(cfg, { siteRoot: '/nowhere' })
    expect(result.data).toEqual([{ id: 1, n: 1 }, { id: 2, n: 2 }])
    expect(calls[0].init).toMatchObject({ method: 'POST', body: JSON.stringify({ query: '{ items }' }) })
  })
})

describe('the sync push reads a binding as the build does', () => {
  const site = (pageYml) => {
    const root = mkdtempSync(join(tmpdir(), 'sync-bindings-'))
    writeFileSync(join(root, 'site.yml'), 'name: T\nfoundation: "@acme/base@1.0.0"\n')
    writeFileSync(join(root, 'queries.yml'), "team:\n  schema: '@/member'\narticles:\n  schema: '@/article'\n")
    mkdirSync(join(root, 'pages', 'team'), { recursive: true })
    writeFileSync(join(root, 'pages', 'team', 'page.yml'), pageYml)
    return root
  }
  const pageFetch = (doc) => JSON.stringify(doc).match(/"fetch":(\[[^\]]*\]|\{[^}]*\})/)?.[1]

  it('⭐ a string in a page\'s `fetch:` list is a query name on the wire', async () => {
    const root = site('title: Team\nfetch: [team, articles]\n')
    const doc = await siteProjectToDocument(root)
    expect(JSON.parse(pageFetch(doc))).toEqual([
      { query: 'team', path: '/data/team.json', as: 'team' },
      { query: 'articles', path: '/data/articles.json', as: 'articles' },
    ])
    rmSync(root, { recursive: true, force: true })
  })

  it('⛔ a `/data/…` path stops the push, as it stops the build', async () => {
    const root = site('title: Team\nfetch: /data/team.json\n')
    await expect(siteProjectToDocument(root)).rejects.toThrow(/a fetch names a query, and a query name is not a path/)
    rmSync(root, { recursive: true, force: true })
  })
})
