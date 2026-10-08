// ⛔ `deferred:` IS RETIRED — 2026-09-27 [Diego]: "the `deferred:` concept keeps getting in the way
// and doesn't match a hosted lane … remove it." A list carries each record's brief on every site, so
// a field a list should leave out belongs in a section of its own, outside the brief.
//
// So a push never carries it, an authored one stops the build and the push, and a pull drops one a
// store still holds from an older push — writing it back would give the author a file that does not
// build. ⛔ Until then `deferred:` was derived from a schema's brief when unstated, pushed, and
// recognized on the way back so the derivation was not persisted (the 2026-08-29 defect).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, declarationsToQueriesYml } from '../src/uwx/index.js'

let ROOT, SITE
const SCHEMA = {
  sections: {
    card: { kind: 'single', brief: true, fields: { title: {}, date: {} } },
    body: { kind: 'single', fields: { content: {}, footnotes: {} } },
    notes: { kind: 'single', fields: { remark: {} } }
  }
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'derived-deferred-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

function makeSite(declExtra = '') {
  const w = (rel, body) => {
    const p = join(ROOT, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
  }
  w('site/site.yml', `name: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    path: collections/articles\n    schema: "@/article"\n${declExtra}`)
  w('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  w('site/collections/articles/hi.md', '---\ntitle: Hi\ndate: 2026-01-01\n---\n\nBody.\n')
  w('fdn/dist/meta/schema.json', { dataSchemas: { '@/article': SCHEMA } })
}

const pulledDecl = (doc) => {
  declarationsToQueriesYml({ document: doc, siteRoot: SITE })
  // The query as the build reads it: `queries.yml` over `site.yml`'s `queries:` block, where this
  // site declares it — and where a pull now leaves it. A BARE map: `queries.yml` has no root key.
  const p = join(SITE, 'queries.yml')
  const fromFile = existsSync(p) ? yaml.load(readFileSync(p, 'utf8'))?.articles : undefined
  const fromSite = yaml.load(readFileSync(join(SITE, 'site.yml'), 'utf8'))?.queries?.articles
  return fromFile ?? fromSite ?? {}
}

describe('`deferred:` is retired', () => {
  it('a push carries none — nothing derives one from a schema\'s brief any more', async () => {
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    const decl = doc.queries.find((c) => c.name === 'articles')
    // CONTROL — the query itself is on the wire
    expect(decl.schema).toBeDefined()
    expect(decl).not.toHaveProperty('deferred')
  })

  it('⛔ an authored `deferred:` stops the push, naming what does its job', async () => {
    makeSite('    deferred: [notes]\n')
    await expect(siteProjectToDocument(SITE)).rejects.toThrow(/`deferred:` is retired\. A list carries each record's brief/)
  })

  it('⛔ a pull drops a `deferred` a store still holds — over a standard schema, and the foundation\'s own', () => {
    mkdirSync(SITE, { recursive: true })
    writeFileSync(join(SITE, 'site.yml'), "name: Clone\nfoundation: '@acme/fnd@1.0.0'\n")
    declarationsToQueriesYml({
      document: {
        info: { foundation: '@acme/fnd@1.0.0' },
        queries: [
          { name: 'articles', schema: '@std/article', sort: 'date desc', deferred: ['body', 'brief'] },
          { name: 'notes', schema: '@acme/note', deferred: ['body'] },
        ],
      },
      siteRoot: SITE,
    })
    const written = yaml.load(readFileSync(join(SITE, 'queries.yml'), 'utf8'))
    expect(written.articles).toEqual({ schema: '@std/article', sort: 'date desc' })
    expect(written.notes).not.toHaveProperty('deferred')
  })
})

// ⭐ QUERIES DECLARED IN site.yml STAY THERE. Measured 2026-09-26: every pull of the `international`
// template, whose queries live in `site.yml`, wrote a `queries.yml` repeating them in the long form —
// its bare `team:` as `team: {}`.
describe('a pull over queries declared in site.yml', () => {
  // `events` states its schema: since 2026-10-08 a pull writes a name-defaulted one out (one spelling
  // per meaning), so the restated file is the one that already says so.
  const SITE_YML = "name: Site\nfoundation: '@acme/fnd@1.0.0'\nqueries:\n  articles:\n    schema: '@std/article'\n    sort: date desc\n  events:\n    schema: '@/events'\n"
  const pullInto = (articles, siteYml = SITE_YML) => {
    mkdirSync(SITE, { recursive: true })
    writeFileSync(join(SITE, 'site.yml'), siteYml)
    declarationsToQueriesYml({
      document: { info: { foundation: '@acme/fnd@1.0.0' }, queries: [articles, { name: 'events', schema: '@acme/events' }] },
      siteRoot: SITE,
    })
  }

  it('⭐ restating them writes nothing — no queries.yml, site.yml as it was', () => {
    pullInto({ name: 'articles', schema: '@std/article', sort: 'date desc', deferred: ['body'] })
    expect(existsSync(join(SITE, 'queries.yml'))).toBe(false)
    expect(readFileSync(join(SITE, 'site.yml'), 'utf8')).toBe(SITE_YML)
  })

  it('⭐ a bare query is written out where it lives — site.yml, never a new queries.yml', () => {
    pullInto({ name: 'articles', schema: '@std/article', sort: 'date desc' }, SITE_YML.replace("  events:\n    schema: '@/events'\n", '  events:\n'))
    expect(existsSync(join(SITE, 'queries.yml'))).toBe(false)
    expect(yaml.load(readFileSync(join(SITE, 'site.yml'), 'utf8')).queries.events).toEqual({ schema: '@/events' })
  })

  it('a query that changed is written back where it lives', () => {
    pullInto({ name: 'articles', schema: '@std/article', sort: 'date asc' })
    expect(existsSync(join(SITE, 'queries.yml'))).toBe(false)
    expect(yaml.load(readFileSync(join(SITE, 'site.yml'), 'utf8')).queries.articles).toEqual({ schema: '@std/article', sort: 'date asc' })
  })
})
