// A query's `schema` must name the Model its records are stored under.
//
// ⛔ WHY. One publish ships a foundation-relative ref (`@/member`) down two paths:
// each record's `$model` (`records.js::buildRecordEntities`) and the query's
// `schema` in the site-content `queries` Section (`site.js::queriesNested`). The
// records path qualified it with the publish org (`@org/member`); the query path
// shipped it verbatim. A consumer answers a query by matching `schema` against the
// Models its records were stored under, so the query named nothing: a hosted page
// asked for `@/member`, the key came back refused, and the section rendered empty
// with a clean console. Every `@std/*` query kept working, because those need no
// qualifying — which is why only a foundation's OWN Models showed it.
//
// ⭐ The first test pins the PAIR, not the fix: the query's `schema` is compared with
// the `$model` the same emit produced, so the two paths cannot drift apart again
// while each still looks right on its own. The pull half pins the inverse, because
// a qualified value written back verbatim would change the author's file on every
// round trip — and, through the derived-`deferred` lookup, reintroduce the
// 2026-08-29 defect.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  emitSyncPackages,
  readZip,
  siteProjectToDocument,
  declarationsToQueriesYml
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

// A site whose query reads a Model from its OWN foundation, with one record of it.
// Queries live in `queries.yml`, the one home a pull writes, so a round trip reads
// back the file it wrote.
function makeSite({ queriesYml, siteYmlExtra = '' }) {
  w('site/site.yml', `name: T\nfoundation: "@acme/fnd"\n${siteYmlExtra}`)
  w('site/queries.yml', queriesYml)
  w('site/package.json', { name: 'site', dependencies: { '@acme/fnd': 'file:../fdn' } })
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  w('site/entities/member/alice.md', '---\nname: Alice\n---\nBio\n')
  w('site/records.yml', '- member/*.md\n')
  w('fdn/dist/meta/schema.json', {
    _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' },
    dataSchemas: {
      '@/member': validateAndNormalizeSchema(
        { name: 'member', fields: { name: { type: 'string' } } },
        '@/member'
      )
    }
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

describe('push — the query names the Model its records were stored under', () => {
  it('⭐ the `queries` Section and the records agree on one qualified name', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    const pkg = await emitSyncPackages(SITE, { org: '@proximify' })
    const models = recordModelsOf(pkg)

    // CONTROL — the records really were qualified. Without it the equality below
    // would also pass for an emitter that qualified neither path.
    expect(models).toEqual(['@proximify/member'])
    // The subject: the query asks for exactly that Model.
    expect(queryOf(siteDocOf(pkg), 'members').schema).toBe(models[0])
  })

  it('a schema that comes from the query NAME is qualified the same way', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\npeople: {}\n' })

    const doc = await siteProjectToDocument(SITE, { org: '@proximify' })

    expect(queryOf(doc, 'people').schema).toBe('@proximify/people')
    expect(queryOf(doc, 'members').schema).toBe('@proximify/member')
  })

  it('accepts a bare org handle as well as `@handle`', async () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    const doc = await siteProjectToDocument(SITE, { org: 'proximify' })

    expect(queryOf(doc, 'members').schema).toBe('@proximify/member')
  })

  it('⛔ with no org known, the query ships `@/member` — the same as its records, which say so', async () => {
    // A `status` probe is offline and orgless. Both paths keep the alias rather than
    // one of them guessing, and the records path's warning names the cause.
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n' })

    const pkg = await emitSyncPackages(SITE)

    expect(recordModelsOf(pkg)).toEqual(['@/member'])
    expect(queryOf(siteDocOf(pkg), 'members').schema).toBe('@/member')
    expect(pkg.warnings.join('\n')).toMatch(/foundation-relative/)
  })

  it('⛔ CONTROL — a ref already in a scope is NOT re-scoped to the publisher', async () => {
    // Without this the suite cannot tell "qualifies `@/`" from "rewrites every ref
    // to the publish org", and the second would silently re-home a shared or
    // other-org Model onto whoever ran the push.
    makeSite({
      queriesYml:
        'members:\n  schema: "@/member"\n' +
        'people:\n  schema: "@std/person"\n' +
        'partners:\n  schema: "@acme/partner"\n'
    })

    const doc = await siteProjectToDocument(SITE, { org: '@proximify' })

    expect(queryOf(doc, 'people').schema).toBe('@std/person')
    expect(queryOf(doc, 'partners').schema).toBe('@acme/partner')
    expect(queryOf(doc, 'members').schema).toBe('@proximify/member')
  })
})

describe('pull — the author’s `@/` comes back', () => {
  it('⭐ a qualified self-org schema is written back as the author wrote it', () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n', siteYmlExtra: '$org: proximify\n' })

    declarationsToQueriesYml({
      document: {
        queries: [
          { name: 'members', schema: '@proximify/member', limit: 5 },
          { name: 'people', schema: '@proximify/people' },
          { name: 'partners', schema: '@acme/partner' }
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
    expect(written.partners.schema).toBe('@acme/partner')
  })

  it('an explicit `org` wins over `site.yml::$org`', () => {
    makeSite({ queriesYml: 'members:\n  schema: "@/member"\n', siteYmlExtra: '$org: someone-else\n' })

    declarationsToQueriesYml({
      document: { queries: [{ name: 'members', schema: '@proximify/member' }] },
      siteRoot: SITE,
      org: '@proximify'
    })

    expect(pulledQueries().members.schema).toBe('@/member')
  })

  it('⛔ a qualified wire does not smuggle a DERIVED `deferred:` into the author file', async () => {
    // The derived-`deferred` check looks the schema up in the foundation's
    // `@/`-keyed data schemas. Handed `@acme/article` it would miss, call the
    // derivation authored, and persist it — the 2026-08-29 defect, reintroduced
    // through the qualifying. Same fixture as `uwx-derived-deferred-not-persisted`.
    w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n$org: acme\n')
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

    const doc = await siteProjectToDocument(SITE, { org: '@acme' })
    const decl = queryOf(doc, 'articles')
    // CONTROL — the wire really carries both the qualified name and a derivation.
    expect(decl.schema).toBe('@acme/article')
    expect(decl.deferred).toEqual(['content', 'footnotes'])

    declarationsToQueriesYml({ document: doc, siteRoot: SITE })
    const written = pulledQueries().articles

    expect(written.deferred).toBeUndefined()
    expect(written.schema).toBe('@/article')
  })
})

describe('round trip — push(pull(x)) is a fixed point', () => {
  it('survives file → wire → file → wire with an org', async () => {
    makeSite({
      queriesYml: 'members:\n  schema: "@/member"\n  limit: 5\npeople: {}\n',
      siteYmlExtra: '$org: proximify\n'
    })

    const first = await siteProjectToDocument(SITE, { org: '@proximify' })
    declarationsToQueriesYml({ document: first, siteRoot: SITE })
    const second = await siteProjectToDocument(SITE, { org: '@proximify' })

    expect(second.queries).toEqual(first.queries)
    // And the author's file says what they wrote.
    const written = pulledQueries()
    expect(written.members.schema).toBe('@/member')
    expect(written.people.schema).toBeUndefined()
  })
})
