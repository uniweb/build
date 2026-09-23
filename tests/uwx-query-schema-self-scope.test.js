// A query's `schema` must name the Model its records are stored under — and both are
// qualified with the FOUNDATION's scope.
//
// ⛔ WHY THE PAIR. One publish ships a foundation-relative ref (`@/member`) down two
// paths: each record's `$model` (`records.js::buildRecordEntities`) and the query's
// `schema` in the site-content `queries` Section (`site.js::queriesNested`). The
// records path qualified it (`@org/member`); the query path shipped it verbatim. A
// consumer answers a query by matching `schema` against the Models its records were
// stored under, so the query named nothing: a hosted page asked for `@/member`, the key
// came back refused, and the section rendered empty with a clean console. Every
// `@std/*` query kept working, because those need no qualifying — which is why only a
// foundation's OWN Models showed it.
//
// ⛔ WHY THE FOUNDATION'S SCOPE (2026-09-22). Both paths qualified with the org that
// owns the SITE, which is a different fact from the scope `register` stored the
// foundation's schemas under — the one in the foundation's name. A site owned by
// `@client` on a foundation registered as `@acme/fnd` shipped its records as
// `@client/member`, a Model that does not exist; a personal site shipped `@/member`
// unresolved. A foundation may be registered under any org its author belongs to
// [Diego], so the two differ by design.
//
// ⭐ The push half pins the PAIR and the SCOPE: the query's `schema` is compared with
// the `$model` the same emit produced, and both with the foundation's name. The pull
// half pins the inverse, because a qualified value written back verbatim would change
// the author's file on every round trip — and, through the derived-`deferred` lookup,
// reintroduce the 2026-08-29 defect.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  emitSyncPackages,
  readZip,
  siteProjectToDocument,
  declarationsToQueriesYml,
  siteSelfScope
} from '../src/uwx/index.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

let ROOT, SITE
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-query-self-scope-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const BACKEND = 'http://backend.test'
const MEMBER = validateAndNormalizeSchema(
  { name: 'member', fields: { name: { type: 'string' } } },
  '@/member'
)

// A site on a LOCAL foundation — `foundation: fnd`, a `file:` dependency — whose
// `main.js` names it `foundationName`, with one record of the foundation's own Model.
// `owner` is the org that owns the SITE, recorded in sync.json as a create records it.
// Queries live in `queries.yml`, the one home a pull writes, so a round trip reads back
// the file it wrote.
function makeSite({ queriesYml, owner = null, foundationName = '@acme/fnd' }) {
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  if (owner) w('site/sync.json', { version: 1, backends: { [BACKEND]: { site: { org: owner } } } })
  w('site/queries.yml', queriesYml)
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  w('site/records/member/alice.md', '---\nname: Alice\n---\nBio\n')
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', `export default {\n  name: '${foundationName}',\n}\n`)
  w('fdn/dist/meta/schema.json', {
    _self: { name: foundationName, version: '1.0.0', role: 'foundation' },
    dataSchemas: { '@/member': MEMBER }
  })
}

const siteDocOf = (pkg) =>
  JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))

// Every record entity's `$model`, as it ships — the folder is not a record.
const recordModelsOf = (pkg) =>
  [...readZip(pkg.records.buffer).entries()]
    .filter(([file]) => file.startsWith('entities/') && file.endsWith('.json'))
    .map(([, buf]) => JSON.parse(buf.toString('utf8')))
    .filter((doc) => doc.$model && doc.$model !== '@uniweb/folder')
    .map((doc) => doc.$model)

const queryOf = (doc, name) => doc.queries.find((q) => q.name === name)

const pulledQueries = () => yaml.load(readFileSync(join(SITE, 'queries.yml'), 'utf8'))

describe('push — `@/x` resolves into the foundation’s scope', () => {
  it('⭐ the `queries` Section and the records agree on the foundation’s scope', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
    const models = recordModelsOf(pkg)

    // CONTROL — the records really were qualified, and with the scope in the
    // foundation's name. Without it the equality below would also pass for an emitter
    // that qualified neither path.
    expect(models).toEqual(['@acme/member'])
    // The subject: the query asks for exactly that Model.
    expect(queryOf(siteDocOf(pkg), 'members').schema).toBe(models[0])
  })

  it('⭐ whoever owns the SITE — another org, or nobody', async () => {
    // The regression: these shipped `@client/member` and `@/member`.
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n', owner: 'client' })
    const other = await emitSyncPackages(SITE, { backend: BACKEND })
    expect(recordModelsOf(other)).toEqual(['@acme/member'])
    expect(queryOf(siteDocOf(other), 'members').schema).toBe('@acme/member')

    rmSync(join(SITE, 'sync.json'))
    const personal = await emitSyncPackages(SITE, { backend: BACKEND })
    expect(recordModelsOf(personal)).toEqual(['@acme/member'])
  })

  it('a site on a CATALOG foundation takes the scope of its ref', async () => {
    // No local foundation at all — the ref names the registered foundation, scope
    // included, so the queries still name its Models.
    w('site/site.yml', 'name: T\nfoundation: "@acme/fnd@1.2.0"\n')
    w('site/queries.yml', 'members:\n  schema: "@/member"\n')
    w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')

    const doc = await siteProjectToDocument(SITE)

    expect(queryOf(doc, 'members').schema).toBe('@acme/member')
  })

  it('a schema that comes from the query NAME is qualified the same way', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\npeople: {}\n' })

    const doc = await siteProjectToDocument(SITE)

    expect(queryOf(doc, 'people').schema).toBe('@acme/people')
    expect(queryOf(doc, 'members').schema).toBe('@acme/member')
  })

  it('an explicit `scope` is used as given, in either spelling', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    expect(queryOf(await siteProjectToDocument(SITE, { scope: 'beta' }), 'members').schema).toBe('@beta/member')
    expect(queryOf(await siteProjectToDocument(SITE, { scope: '@beta' }), 'members').schema).toBe('@beta/member')
  })

  it('⛔ a foundation with no scope yet ships `@/member` — the same as its records, which say so', async () => {
    // A bare name has not registered: `register` writes the scope it chooses into the
    // name. Both paths keep the alias rather than one of them guessing, and the
    // records path's warning names the cause.
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n', foundationName: 'fnd-one', owner: 'client' })

    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })

    expect(recordModelsOf(pkg)).toEqual(['@/member'])
    expect(queryOf(siteDocOf(pkg), 'members').schema).toBe('@/member')
    expect(pkg.warnings.join('\n')).toMatch(/foundation-relative/)
  })

  it('⛔ CONTROL — a ref already in a scope is NOT re-scoped', async () => {
    // Without this the suite cannot tell "qualifies `@/`" from "rewrites every ref to
    // the scope", and the second would silently re-home a shared or other-org Model.
    makeSite({
      queriesYml:
        'members:\n  schema: "@/member"\n' +
        'people:\n  schema: "@std/person"\n' +
        'partners:\n  schema: "@beta/partner"\n'
    })

    const doc = await siteProjectToDocument(SITE)

    expect(queryOf(doc, 'people').schema).toBe('@std/person')
    expect(queryOf(doc, 'partners').schema).toBe('@beta/partner')
    expect(queryOf(doc, 'members').schema).toBe('@acme/member')
  })

  it('⛔ refuses the retired `org` — it carried the site owner', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    await expect(emitSyncPackages(SITE, { org: '@client' })).rejects.toThrow(/`org` is no longer read/)
    await expect(siteProjectToDocument(SITE, { org: '@client' })).rejects.toThrow(/`org` is no longer read/)
  })
})

describe('pull — the author’s `@/` comes back', () => {
  it('⭐ a schema in the scope of the pulled site’s foundation ref is written back as the author wrote it', () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    declarationsToQueriesYml({
      document: {
        // The pinned ref a pushed site carries — the scope its queries were qualified with.
        info: { foundation: '@acme/fnd@1.0.0' },
        queries: [
          { name: 'members', schema: '@acme/member', limit: 5 },
          { name: 'people', schema: '@acme/people' },
          { name: 'partners', schema: '@beta/partner' }
        ]
      },
      siteRoot: SITE
    })
    const written = pulledQueries()

    expect(written.members.schema).toBe('@/member')
    // CONTROL — the declaration was really projected, so the value above is not an
    // untouched file reading back what the fixture wrote.
    expect(written.members.limit).toBe(5)
    // A name-defaulted schema stays unwritten: the terse file stays terse.
    expect(written.people.schema).toBeUndefined()
    // Another org's Model is that org's; `@/` would be a lie.
    expect(written.partners.schema).toBe('@beta/partner')
  })

  it('an explicit `scope` wins over the document’s ref', () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    declarationsToQueriesYml({
      document: {
        info: { foundation: '@other/fnd@1.0.0' },
        queries: [{ name: 'members', schema: '@acme/member' }]
      },
      siteRoot: SITE,
      scope: '@acme'
    })

    expect(pulledQueries().members.schema).toBe('@/member')
  })

  it('⛔ the site OWNER is not the scope: with none known, a qualified schema stays explicit', () => {
    // sync.json records the site's owner; the pull no longer reads it. With no scope
    // stated and no pinned ref, `@acme/member` is written as it is — explicit, and
    // still the right Model — rather than rewritten against the wrong org.
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n', owner: 'acme' })

    declarationsToQueriesYml({
      document: { queries: [{ name: 'members', schema: '@acme/member' }] },
      siteRoot: SITE
    })

    expect(pulledQueries().members.schema).toBe('@acme/member')
  })

  it('⛔ a qualified wire does not smuggle a DERIVED `deferred:` into the author file', async () => {
    // The derived-`deferred` check looks the schema up in the foundation's
    // `@/`-keyed data schemas. Handed `@acme/article` it would miss, call the
    // derivation authored, and persist it — the 2026-08-29 defect, reintroduced
    // through the qualifying. Same fixture as `uwx-derived-deferred-not-persisted`.
    w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n')
    w('site/queries.yml', 'articles:\n  path: collections/articles\n  schema: "@/article"\n')
    w('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
    w('site/collections/articles/hi.md', '---\ntitle: Hi\ndate: 2026-01-01\n---\n\nBody.\n')
    w('fdn/dist/meta/schema.json', {
      dataSchemas: {
        '@/article': {
          sections: {
            card: { kind: 'single', brief: true, fields: { title: {}, date: {} } },
            body: { kind: 'single', fields: { content: {}, footnotes: {} } }
          }
        }
      }
    })

    const doc = await siteProjectToDocument(SITE, { scope: '@acme' })
    const decl = queryOf(doc, 'articles')
    // CONTROL — the wire really carries both the qualified name and a derivation.
    expect(decl.schema).toBe('@acme/article')
    expect(decl.deferred).toEqual(['content', 'footnotes'])

    declarationsToQueriesYml({ document: doc, siteRoot: SITE, scope: '@acme' })
    const written = pulledQueries().articles

    expect(written.deferred).toBeUndefined()
    expect(written.schema).toBe('@/article')
  })

  it('⛔ refuses the retired `org`', () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    expect(() =>
      declarationsToQueriesYml({ document: { queries: [] }, siteRoot: SITE, org: '@acme' })
    ).toThrow(/`org` is no longer read/)
  })
})

describe('round trip — push(pull(x)) is a fixed point', () => {
  it('survives file → wire → file → wire, with the scope a pull resolves up front', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n  limit: 5\npeople: {}\n', owner: 'client' })

    const first = await siteProjectToDocument(SITE)
    // What `uniweb pull` does: resolve the scope up front, hand it to the projection.
    const scope = await siteSelfScope(SITE)
    expect(scope).toBe('@acme')
    declarationsToQueriesYml({ document: first, siteRoot: SITE, scope })
    const second = await siteProjectToDocument(SITE)

    expect(second.queries).toEqual(first.queries)
    // And the author's file says what they wrote.
    const written = pulledQueries()
    expect(written.members.schema).toBe('@/member')
    expect(written.people.schema).toBeUndefined()
  })
})
