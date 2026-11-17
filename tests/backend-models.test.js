/**
 * ⭐ A MODEL ONLY A SITE BACKEND HOLDS — `@uniweb/catalog`, the site's store (2026-11-16).
 *
 * A visitor who isn't signed in sees the store's prices through a site query on `@uniweb/catalog`,
 * answered by the published site's records service once the owner makes the catalog public. Until
 * 2026-11-16 a site could not declare it: the foundation build refused
 * a data key of it as a reserved name, the static build said to keep its records in
 * `records/uniweb/catalog/`, and a push named it a Model the backend has none of, since the backend's
 * data-schema read answers 404 for its system Models. So a solution asked the records service itself.
 *
 * A site reads one and holds none: the owner writes its records in the app, so a file kept as one is
 * refused, by the build and by the push. Nothing here defines it (`src/backend-models.js`).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'
import { emitSyncPackages, readZip } from '../src/uwx/index.js'
import { buildSchema } from '../src/schema.js'
import { extractRuntimeSchema } from '../src/runtime-schema.js'
import { isBackendModel } from '../src/backend-models.js'
import { blueprintWarnings, siteDeclaredTypes } from '../src/uwx/blueprint.js'
import yaml from 'js-yaml'

let ROOT, SITE, FDN, logs, warns
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uw-backend-models-'))
  SITE = join(ROOT, 'site')
  FDN = join(ROOT, 'fdn')
  logs = []
  warns = []
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')))
  vi.spyOn(console, 'warn').mockImplementation((...a) => warns.push(a.join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const STORE = { schema: '@uniweb/catalog', whole: true }

// A site on a local foundation `@acme/fnd` whose `Store` section reads the store's catalogs, whole.
async function makeSite({ queriesYml = 'store:\n  schema: "@uniweb/catalog"\n', storeKey = STORE } = {}) {
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/queries.yml', queriesYml)
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/1-prices.md', '---\ntype: Store\nquery: store\n---\n')
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  w('fdn/sections/Store/meta.js', `export default { data: { store: ${JSON.stringify(storeKey)} } }\n`)
  w('fdn/sections/Store/index.jsx', 'export default function Store() { return null }\n')
  w('fdn/dist/meta/schema.json', await buildSchema(FDN))
}

const emit = () => emitSyncPackages(SITE, { backend: 'http://backend.test' })
const wireQuery = async (pkg, name) =>
  JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8')).queries.find((q) => q.name === name)

describe('the name', () => {
  it('is the catalog alone — not the system Models a site keeps records of', () => {
    expect(isBackendModel('@uniweb/catalog')).toBe(true)
    for (const ref of ['@uniweb/link', '@uniweb/file', '@std/article', '@acme/catalog', '@/catalog', null]) {
      expect(isBackendModel(ref)).toBe(false)
    }
  })
})

describe('a foundation that reads the store', () => {
  it('⭐ builds, with the key as written and no copy of the Model', async () => {
    await makeSite()
    const schema = JSON.parse(readFileSync(join(FDN, 'dist/meta/schema.json'), 'utf8'))
    expect(schema.Store.data).toEqual({ store: STORE })
    expect(schema.dataSchemas?.['@uniweb/catalog']).toBeUndefined()
  })

  it('and what a page renders with carries the ref and `whole`', () => {
    expect(extractRuntimeSchema({ data: { store: STORE } }).data).toEqual({ store: STORE })
  })

  it('CONTROL — another `@uniweb/` name is still refused, naming what a site may read', async () => {
    w('fdn/package.json', { name: 'fnd', type: 'module' })
    w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
    w('fdn/sections/Shop/meta.js', "export default { data: { shop: '@uniweb/shop' } }\n")
    w('fdn/sections/Shop/index.jsx', 'export default function Shop() { return null }\n')
    await expect(buildSchema(FDN)).rejects.toThrow(
      /the only data schemas a site's records may name in it are '@uniweb\/link', '@uniweb\/file', and a query or a data key may also read '@uniweb\/catalog'/
    )
  })
})

describe('the static build', () => {
  it('⭐ compiles none of its records and says where they come from, with no warning', async () => {
    await makeSite()
    const queries = (await collectSiteContent(SITE, { foundationPath: FDN })).config.queries
    expect(queries.store.schema).toBe('@uniweb/catalog')
    const byQuery = await processQueries(SITE, queries, undefined, '/', { locale: 'en' })
    await writeQueryFiles(SITE, byQuery, queries)
    expect(JSON.parse(readFileSync(join(SITE, 'public/data/store.json'), 'utf8'))).toEqual([])
    expect(logs.join('\n')).toMatch(/Query "store" reads @uniweb\/catalog, which only a site backend holds.*uniweb dev --published/)
    expect(warns.filter((m) => /catalog/.test(m))).toEqual([])
  })

  it('⛔ stops on a file kept as one of its records', async () => {
    await makeSite()
    w('site/records/uniweb/catalog/main.yml', 'info:\n  name: Main\n  currency: CAD\n')
    await expect(processQueries(SITE, { store: { schema: '@uniweb/catalog' } }, undefined, '/')).rejects.toThrow(
      /records\/uniweb\/catalog\/: @uniweb\/catalog is a site backend's own, so a site holds none of its records/
    )
  })
})

describe('a push', () => {
  it('⭐ sends the query as written, and asks the backend for no Model', async () => {
    await makeSite()
    const resolveModel = vi.fn(async () => null)
    const pkg = await emitSyncPackages(SITE, { backend: 'http://backend.test', resolveModel })
    expect(await wireQuery(pkg, 'store')).toMatchObject({ name: 'store', schema: '@uniweb/catalog' })
    expect(pkg.refusals).toEqual([])
    expect(pkg.warnings).toEqual([])
    expect(resolveModel).not.toHaveBeenCalledWith('@uniweb/catalog')
  })

  it('⛔ refuses a file kept as one of its records', async () => {
    await makeSite()
    w('site/records/uniweb/catalog/main.yml', 'info:\n  name: Main\n  currency: CAD\n')
    const pkg = await emit()
    expect(pkg.refusals).toEqual([expect.stringMatching(/^records\/uniweb\/catalog\/: @uniweb\/catalog is a site backend's own/)])
  })

  it('CONTROL — a query on another `@uniweb/` name is still refused', async () => {
    await makeSite({ queriesYml: 'shop:\n  schema: "@uniweb/shop"\n' })
    await expect(emit()).rejects.toThrow(/Model "@uniweb\/shop" \(query "shop"\) could not be resolved/)
  })
})

describe('a query a data key types', () => {
  it('⭐ a query named like the key, with no schema, reads the catalog on both lanes', async () => {
    await makeSite({ queriesYml: 'store: {}\n' })
    const queries = (await collectSiteContent(SITE, { foundationPath: FDN })).config.queries
    expect(queries.store.schema).toBe('@uniweb/catalog')
    expect((await processQueries(SITE, queries, undefined, '/')).store).toEqual([])
    const pkg = await emit()
    expect((await wireQuery(pkg, 'store')).schema).toBe('@uniweb/catalog')
    expect(pkg.refusals).toEqual([])
    expect(pkg.warnings).toEqual([])
  })

  it('⛔ and a folder named for that key is a folder of its records, refused by the build and the push', async () => {
    await makeSite({ queriesYml: 'store: {}\n' })
    w('site/records/store/main.yml', 'info:\n  name: Main\n  currency: CAD\n')
    const queries = (await collectSiteContent(SITE, { foundationPath: FDN })).config.queries
    await expect(processQueries(SITE, queries, undefined, '/')).rejects.toThrow(
      /records\/store\/: @uniweb\/catalog is a site backend's own/
    )
    expect((await emit()).refusals).toEqual([expect.stringMatching(/^records\/store\/: @uniweb\/catalog is a site backend's own/)])
  })
})

describe("a blueprint that opens it to visitors", () => {
  const opensIt = { publicQueries: { '@uniweb/catalog': { whole: true } } }
  const declaredOf = () => siteDeclaredTypes(SITE, yaml.load(readFileSync(join(SITE, 'site.yml'), 'utf8')), { scope: '@acme' })

  it('⭐ names no type it does not know: a section that reads the catalog declares it', async () => {
    await makeSite()
    const declared = await declaredOf()
    expect(declared.types.has('@uniweb/catalog')).toBe(true)
    expect(blueprintWarnings(opensIt, { scope: '@acme', declared })).toEqual([])
  })

  it('CONTROL — with no section that reads it, the line is still named as one a backend leaves out', async () => {
    await makeSite({ storeKey: '@std/article' })
    const declared = await declaredOf()
    expect(declared.types.has('@uniweb/catalog')).toBe(false)
    expect(blueprintWarnings(opensIt, { scope: '@acme', declared })).toEqual([
      expect.stringMatching(/`publicQueries\.@uniweb\/catalog` names a type none of this site's foundations declares/),
    ])
  })
})
