// A pull must not write a DERIVED value into the author's file as though they typed it.
//
// ⛔ WHY. `deferred:` is derived from the schema's brief when unstated — this package's
// own `deferred-from-brief.test.js` opens with "derived from a collection's data schema,
// NOT written by hand". But `deriveDeferredFromSchemas` mutates the declaration in place,
// so by the time it reaches the wire an emitted `deferred` is indistinguishable from an
// authored one, and the projection wrote it back.
//
// ⚠️ Measured 2026-08-29: one push + one pull turned an unstated `deferred:` into a
// hardcoded list in the query config — a DIFFERENT file, at HIGHER precedence than the
// `site.yml` the collection was declared in. The collection then stopped tracking its
// schema's brief permanently, and nothing reported it. Add a field to the brief and the
// site would never see it.
//
// ⭐ The fix mirrors what `schema` already did five lines above: emit on push (the
// backend needs the effective value), drop on pull when it merely restates the
// derivation. AUTHORED intent must survive — that is the second test here, and without
// it the first would pass just as well for an implementation that dropped `deferred`
// unconditionally, which would be a worse bug than the one being fixed.

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

describe('a derived deferred does not become authored config', () => {
  it('CONTROL — the derivation happens and rides the wire', async () => {
    // Without this, the assertion below would pass for a build that never derived
    // anything at all: "not written back" and "never existed" look identical in the file.
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    // Every section but the brief, by name.
    expect(doc.queries.find((c) => c.name === 'articles').deferred).toEqual(['body', 'notes'])
  })

  it('⛔ pull does NOT write the derived value into the author file', async () => {
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    expect(pulledDecl(doc).deferred).toBeUndefined()
  })

  it('⛔ an AUTHORED deferred survives the round trip', async () => {
    // The guard against over-correcting. `notes` alone is narrower than the brief
    // implies, so it is intent, not derivation — dropping it would silently discard what
    // the author asked for, which is worse than the bug being fixed.
    makeSite('    deferred: [notes]\n')
    const doc = await siteProjectToDocument(SITE)
    expect(pulledDecl(doc).deferred).toEqual(['notes'])
  })

  it('an authored deferred that HAPPENS to equal the derivation is dropped, and that is correct', async () => {
    // It is indistinguishable from the derived value by construction — nothing on the
    // wire records who wrote it — and dropping it is lossless: the schema re-derives the
    // same list. Pinned so the behaviour is a decision rather than an accident.
    makeSite('    deferred: [body, notes]\n')
    const doc = await siteProjectToDocument(SITE)
    expect(pulledDecl(doc).deferred).toBeUndefined()
  })

  it('order does not decide it — a reordered derivation is still recognized', async () => {
    // The deriver walks the schema's sections; a round trip through YAML and the store is
    // not obliged to preserve that order. A list comparison would call this authored.
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    const decl = doc.queries.find((c) => c.name === 'articles')
    decl.deferred = [...decl.deferred].reverse()
    expect(pulledDecl(doc).deferred).toBeUndefined()
  })
})

// ⭐ A CLONE HAS NO FOUNDATION ON DISK — but a standard schema is known without one. Measured
// 2026-09-25: a clone of the `international` template wrote `articles: { deferred: [article_body] }`,
// the derivation from `@std/article`, into the author's queries.
describe('a clone’s query over a standard schema', () => {
  const pullInto = (deferred) => {
    mkdirSync(SITE, { recursive: true })
    writeFileSync(join(SITE, 'site.yml'), "name: Clone\nfoundation: '@acme/fnd@1.0.0'\n")
    declarationsToQueriesYml({
      document: { info: { foundation: '@acme/fnd@1.0.0' }, queries: [{ name: 'articles', schema: '@std/article', sort: 'date desc', deferred }] },
      siteRoot: SITE,
    })
    return yaml.load(readFileSync(join(SITE, 'queries.yml'), 'utf8')).articles
  }

  it('⛔ does not get the derived `deferred:` written into it', () => {
    expect(pullInto(['article_body'])).toEqual({ schema: '@std/article', sort: 'date desc' })
  })

  it('CONTROL — an authored `deferred:` that differs from the derivation survives', () => {
    expect(pullInto(['article_body', 'article']).deferred).toEqual(['article_body', 'article'])
  })
})

// ⭐ QUERIES DECLARED IN site.yml STAY THERE. Measured 2026-09-26: every pull of the `international`
// template, whose queries live in `site.yml`, wrote a `queries.yml` repeating them in the long form —
// its bare `team:` as `team: {}`.
describe('a pull over queries declared in site.yml', () => {
  const SITE_YML = "name: Site\nfoundation: '@acme/fnd@1.0.0'\nqueries:\n  articles:\n    schema: '@std/article'\n    sort: date desc\n  events:\n"
  const pullInto = (articles) => {
    mkdirSync(SITE, { recursive: true })
    writeFileSync(join(SITE, 'site.yml'), SITE_YML)
    declarationsToQueriesYml({
      document: { info: { foundation: '@acme/fnd@1.0.0' }, queries: [articles, { name: 'events', schema: '@acme/events' }] },
      siteRoot: SITE,
    })
  }

  it('⭐ restating them writes nothing — no queries.yml, site.yml as it was', () => {
    pullInto({ name: 'articles', schema: '@std/article', sort: 'date desc', deferred: ['article_body'] })
    expect(existsSync(join(SITE, 'queries.yml'))).toBe(false)
    expect(readFileSync(join(SITE, 'site.yml'), 'utf8')).toBe(SITE_YML)
  })

  it('a query that changed is written back where it lives', () => {
    pullInto({ name: 'articles', schema: '@std/article', sort: 'date asc' })
    expect(existsSync(join(SITE, 'queries.yml'))).toBe(false)
    expect(yaml.load(readFileSync(join(SITE, 'site.yml'), 'utf8')).queries.articles).toEqual({ schema: '@std/article', sort: 'date asc' })
  })
})
