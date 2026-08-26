// A site's collection declarations are resolved ONCE, and the site build sees
// what the author wrote wherever they wrote it.
//
// Before this converged, `build/src/site/` read `site.yml::collections` directly
// while only the sync lane merged `collections/collections.yml` over it. A
// collection declared only in `collections.yml` was therefore invisible to the
// build — never compiled, `data: <name>` delivering nothing — while sync pushed
// it fine. Declared in both, the build used `site.yml`'s values and sync used
// `collections.yml`'s, silently.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { resolveCollectionsConfig, toConfigCollections } from '../src/site/collections-config.js'

let ROOT

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

const setup = (siteYml, collectionsYml) => {
  w('site.yml', siteYml)
  if (collectionsYml) w('collections/collections.yml', collectionsYml)
  w('collections/news/hello.md', '---\ntitle: Hello\n---\n\nBody.\n')
  w('pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
}

const collections = async () => (await collectSiteContent(ROOT, {})).config?.collections ?? null

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'coll-cfg-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the site build sees collections.yml', () => {
  it('finds a collection declared ONLY in collections.yml', async () => {
    setup('name: T\nfoundation: "@a/x"\n', 'collections:\n  news:\n    path: news\n')
    expect(Object.keys(await collections())).toEqual(['news'])
  })

  it('lets collections.yml win per key over site.yml', async () => {
    setup(
      'name: T\nfoundation: "@a/x"\ncollections:\n  news:\n    path: collections/news\n    sort: date asc\n',
      'collections:\n  news:\n    sort: date desc\n    deferred: [body]\n'
    )
    const news = (await collections()).news
    // The measured regression: the author wrote `date desc` and the build baked
    // `date asc` into the static file.
    expect(news.sort).toBe('date desc')
    expect(news.deferred).toEqual(['body'])
  })

  it('leaves a site.yml-only declaration exactly as it was', async () => {
    // The control. Convergence must be additive for every site that never
    // adopted collections.yml, which is most of them.
    setup('name: T\nfoundation: "@a/x"\ncollections:\n  news:\n    path: collections/news\n    sort: date asc\n')
    const news = (await collections()).news
    expect(news.path).toBe('collections/news')
    expect(news.sort).toBe('date asc')
  })

  it('keeps config.collections absent when a site declares none', async () => {
    // Absent, not `{}` — an empty object reads as "declared, and empty" to
    // anything testing for presence.
    w('site.yml', 'name: T\nfoundation: "@a/x"\n')
    w('pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
    expect(await collections()).toBeNull()
  })
})

describe('toConfigCollections — what reaches the payload', () => {
  it('strips schemaExplicit, an internal resolution detail', async () => {
    setup('name: T\nfoundation: "@a/x"\n', 'collections:\n  news:\n    path: news\n')
    const resolved = await resolveCollectionsConfig(ROOT)
    expect('schemaExplicit' in resolved.declarations.news).toBe(true)
    expect('schemaExplicit' in toConfigCollections(resolved.declarations).news).toBe(false)
    expect('schemaExplicit' in (await collections()).news).toBe(false)
  })

  it('returns undefined rather than an empty object', () => {
    expect(toConfigCollections({})).toBeUndefined()
    expect(toConfigCollections(null)).toBeUndefined()
  })

  it('carries the resolved schema, which the build previously never saw', async () => {
    setup('name: T\nfoundation: "@a/x"\n', 'collections:\n  news:\n    path: news\n    schema: "@/article"\n')
    expect((await collections()).news.schema).toBe('@/article')
  })
})
