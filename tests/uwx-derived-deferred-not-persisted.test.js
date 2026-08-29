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
import { siteProjectToDocument, declarationsToCollectionsYml } from '../src/uwx/index.js'

let ROOT, SITE
const SCHEMA = {
  sections: {
    card: { kind: 'single', brief: true, fields: { title: {}, date: {} } },
    body: { kind: 'single', fields: { content: {}, footnotes: {} } }
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
  declarationsToCollectionsYml({ document: doc, siteRoot: SITE })
  const p = join(SITE, 'queries.yml')
  // A BARE map — `queries.yml` has no root key, so the query is read directly.
  return existsSync(p) ? (yaml.load(readFileSync(p, 'utf8'))?.articles ?? {}) : {}
}

describe('a derived deferred does not become authored config', () => {
  it('CONTROL — the derivation happens and rides the wire', async () => {
    // Without this, the assertion below would pass for a build that never derived
    // anything at all: "not written back" and "never existed" look identical in the file.
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    expect(doc.queries.find((c) => c.name === 'articles').deferred).toEqual([
      'content',
      'footnotes'
    ])
  })

  it('⛔ pull does NOT write the derived value into the author file', async () => {
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    expect(pulledDecl(doc).deferred).toBeUndefined()
  })

  it('⛔ an AUTHORED deferred survives the round trip', async () => {
    // The guard against over-correcting. `footnotes` alone is narrower than the brief
    // implies, so it is intent, not derivation — dropping it would silently discard what
    // the author asked for, which is worse than the bug being fixed.
    makeSite('    deferred: [footnotes]\n')
    const doc = await siteProjectToDocument(SITE)
    expect(pulledDecl(doc).deferred).toEqual(['footnotes'])
  })

  it('an authored deferred that HAPPENS to equal the derivation is dropped, and that is correct', async () => {
    // It is indistinguishable from the derived value by construction — nothing on the
    // wire records who wrote it — and dropping it is lossless: the schema re-derives the
    // same list. Pinned so the behaviour is a decision rather than an accident.
    makeSite('    deferred: [content, footnotes]\n')
    const doc = await siteProjectToDocument(SITE)
    expect(pulledDecl(doc).deferred).toBeUndefined()
  })

  it('order does not decide it — a reordered derivation is still recognized', async () => {
    // The deriver walks `flatRecordFields`; a round trip through YAML and the store is
    // not obliged to preserve that order. A list comparison would call this authored.
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    const decl = doc.queries.find((c) => c.name === 'articles')
    decl.deferred = [...decl.deferred].reverse()
    expect(pulledDecl(doc).deferred).toBeUndefined()
  })
})
