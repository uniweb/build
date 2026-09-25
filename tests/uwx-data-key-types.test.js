/**
 * ⭐ A NAME THAT IS A DATA KEY, NOT A DATA SCHEMA — its records are of the key's type.
 *
 * [Diego, 2026-09-25] — "if team is just a data key for the `@std/member` type and that type
 * has a schema, it should not be understood as missing a schema and becoming static data."
 *
 * A query `team:` with no `schema:` defaults to `@/team`, and so does `records/team/`. A
 * section type declaring `data: { team: '@/member' }` says what those records are; until then
 * a push found no `@/team` and shipped them as static files.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { emitSyncPackages, readZip, declarationsToQueriesYml, recordsToProject } from '../src/uwx/index.js'
import { dataKeyTypes } from '../src/uwx/data-key-types.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

let ROOT, SITE
const BACKEND = 'http://backend.test'
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-data-key-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const MEMBER = validateAndNormalizeSchema({ name: 'member', fields: { name: { type: 'string' } } }, '@/member')

// A site on a local foundation `@acme/fnd` that defines `member`, and a section type reading
// the data key `team`, typed as given. `team` is a query with no schema; its records are in
// `records/team/`, as the international template keeps them.
function makeSite({ teamType = '@/member', sections = null, queriesYml = 'team: {}\n' } = {}) {
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/queries.yml', queriesYml)
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/records/team/wei.yml', 'name: Wei\n')
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  w('fdn/dist/meta/schema.json', {
    _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' },
    dataSchemas: { '@/member': MEMBER },
    ...(sections || { Team: { data: { team: teamType } } }),
  })
}

const docs = (pkg) =>
  [...readZip(pkg.records.buffer)]
    .filter(([name]) => name.startsWith('entities/'))
    .map(([, buf]) => JSON.parse(buf.toString('utf8')))
const siteDocOf = (pkg) => JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))

describe('dataKeyTypes — what each data key of a foundation is typed as', () => {
  it('reads every section type’s `data:`, and drops a key typed two ways', () => {
    const types = dataKeyTypes({
      _self: {},
      dataSchemas: {},
      Team: { data: { team: '@/member', people: { schema: '@std/person' } } },
      Grid: { data: { team: '@/member', things: {} } },
      Other: { data: { clash: '@/a' } },
      More: { data: { clash: '@/b' } },
    })
    expect(Object.fromEntries(types)).toEqual({ team: '@/member', people: '@std/person' })
  })

  it('reads the foundation’s own keys (`main.js` `data:`) and each layout’s too', () => {
    const types = dataKeyTypes({
      _self: { data: { invoices: '@/invoice', sows: {} } },
      _layouts: { Default: { data: { nav: '@std/nav' } } },
      Invoice: {},
    })
    expect(Object.fromEntries(types)).toEqual({ invoices: '@/invoice', nav: '@std/nav' })
  })
})

describe('push — a query named for a typed data key sends records of the type', () => {
  it('⭐ `team`’s records are `@acme/member` entities, and the query names that type', async () => {
    makeSite()
    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
    expect(pkg.refusals).toEqual([])
    expect(pkg.schemaless).toEqual([])
    const wei = docs(pkg).find((d) => d.$id === 'team/wei')
    expect(wei.$schema).toBe('@acme/member')
    expect(siteDocOf(pkg).queries.find((q) => q.name === 'team').schema).toBe('@acme/member')
  })

  it('CONTROL — an untyped key names no type: `team` still ships as static files', async () => {
    makeSite({ teamType: {} })
    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
    expect(pkg.schemaless.map((q) => q.name)).toEqual(['team'])
  })

  it('CONTROL — a key two section types type differently names no type', async () => {
    makeSite({ sections: { Team: { data: { team: '@/member' } }, Grid: { data: { team: '@/other' } } } })
    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
    expect(pkg.schemaless.map((q) => q.name)).toEqual(['team'])
  })

  it('⛔ a schema the query names EXPLICITLY is the author’s — it fails loudly, never falls back', async () => {
    makeSite({ queriesYml: 'team:\n  schema: "@/team"\n' })
    await expect(emitSyncPackages(SITE, { backend: BACKEND })).rejects.toThrow(/Model "@acme\/team" \(query "team"\) could not be resolved/)
  })
})

describe('pull — the same rule, backwards', () => {
  it('a pulled `team` naming the key’s type is written back terse', () => {
    makeSite()
    declarationsToQueriesYml({
      document: { info: { foundation: '@acme/fnd@1.0.0' }, queries: [{ name: 'team', schema: '@acme/member' }] },
      siteRoot: SITE,
    })
    const q = yaml.load(readFileSync(join(SITE, 'queries.yml'), 'utf8'))
    expect(q.team?.schema).toBeUndefined()
  })

  it('a new member is placed where the project keeps them — `records/team/`', () => {
    makeSite()
    const report = recordsToProject({
      folderDoc: { contents: [{ kind: 'ref', name: 'lin', entry: { schema: '@acme/member', entity: 'U-LIN' } }] },
      recordDocs: [{ $uuid: 'U-LIN', $schema: '@acme/member', member: { name: 'Lin' } }],
      siteRoot: SITE,
      opts: { backend: BACKEND, resolveDeclaration: () => ({ name: '@acme/member', sections: { member: { brief: true, fields: { name: { type: 'string' } } } } }), scope: '@acme' },
    })
    expect(report.skipped).toEqual([])
    expect(report.placed.map((p) => p.slice(SITE.length + 1))).toEqual(['records/team/lin.yml'])
    expect(existsSync(join(SITE, 'records/member'))).toBe(false)
  })
})
