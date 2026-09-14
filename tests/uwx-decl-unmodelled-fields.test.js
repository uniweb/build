// A decl field framework does not model must survive the round trip.
//
// ⛔ WHY. The `collections` decl's field set is the BACKEND's — this document
// mirrors the `@uniweb/site-content` Model (`uwx/site.js:11`, `:309`) — and their
// reconcile replaces an item's `data` WHOLESALE, at no field grain. So an allowlist
// in our emitter does not merely fail to send an unmodelled field: it DESTROYS
// whatever was stored under it, on every push, silently.
//
// ⚠️ Measured 2026-08-29 (channel framework↔backend): the Model declares
// ELEVEN decl fields; this emitter knew ten. The eleventh is `label` — which
// framework has no authoring concept for, since `label` here is a `folders:`
// BRANCH field (`{segment, label, entries}`), not a property of a collection.
//
// ⭐ `label` is the instance, not the defect. Both directions were hardcoded
// allowlists facing each other, so any field the Model gains repeats this. These
// tests use a deliberately INVENTED field name, not `label`, because pinning the
// instance would let the next one through.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, declarationsToQueriesYml } from '../src/uwx/index.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-decl-unmodelled-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// A site with one query whose decl carries a field this build has never heard of,
// alongside one it models.
function makeSite(declYml) {
  const src = join(dir, 'src')
  mkdirSync(join(src, 'collections', 'members'), { recursive: true })
  writeFileSync(join(src, 'site.yml'), "name: T\nfoundation: '@acme/base@1.0.0'\n")
  writeFileSync(join(src, 'queries.yml'), declYml)
  return src
}

const withUnmodelled = `members:
  schema: '@std/person'
  limit: 10
  displayHeading: Our Team
`

describe('push — an unmodelled decl field reaches the wire', () => {
  it('carries a field the emitter does not model, verbatim', async () => {
    const src = makeSite(withUnmodelled)

    const doc = await siteProjectToDocument(src)
    const decl = doc.queries.find((c) => c.name === 'members')

    // The subject.
    expect(decl.displayHeading).toBe('Our Team')

    // CONTROL — a field the emitter DOES model, on the same record. Without this
    // the assertion above would pass identically if the whole decl were passed
    // through raw, which would be a different (and wrong) implementation.
    expect(decl.limit).toBe(10)
    expect(decl.schema).toBe('@std/person')
  })

  it('⛔ a FOLDED field rides once, inside `source` only', async () => {
    // ⚠️ The control the first draft of this change lacked: a pass-through that
    // skips keys "already in data" does not recognize a field emitted under another
    // name, and emits BOTH. An external query's `method`, `body`, `transform` and
    // `record` ride inside `source` (2026-09-13), so they are that case now — the
    // renamed `detailUrl` → `detail_url` it was written for is retired.
    const src = makeSite(
"items:\n  url: https://api.test/items\n  method: POST\n  body: { q: all }\n  transform: data.items\n  record: { url: 'https://api.test/items/{slug}' }\n"
    )

    const doc = await siteProjectToDocument(src)
    const decl = doc.queries.find((c) => c.name === 'items')

    expect(decl.source).toEqual({
      url: 'https://api.test/items',
      method: 'POST',
      body: { q: 'all' },
      transform: 'data.items',
      record: { url: 'https://api.test/items/{slug}' },
    })
    for (const key of ['url', 'method', 'body', 'transform', 'record']) expect(decl[key]).toBeUndefined()
  })

  it('⛔ a query declaring the retired framework-local `route:` does not push at all', async () => {
    // `route:` was framework's, not the Model's — `collectItems` baked each item's link
    // from it — and it was withheld from the wire. It is refused since 2026-09-14: a
    // record links to its query's page as `$route`, filled at render time.
    const src = makeSite(
"members:\n  schema: '@std/person'\n  route: /team\n"
    )
    await expect(siteProjectToDocument(src)).rejects.toThrow(/`route:` is retired/)

    // CONTROL — the same query without it pushes, carrying its modelled fields
    const doc = await siteProjectToDocument(makeSite("members:\n  schema: '@std/person'\n"))
    const decl = doc.queries.find((c) => c.name === 'members')
    expect(decl.schema).toBe('@std/person')
    expect(decl.route).toBeUndefined()
  })

  it('⛔ still withholds framework-local keys — pass-through is not a raw dump', async () => {
    const src = makeSite(withUnmodelled)

    const doc = await siteProjectToDocument(src)
    const decl = doc.queries.find((c) => c.name === 'members')

    // `schemaExplicit` is build state: it records whether the AUTHOR asked for the
    // schema or the query-name convention supplied it, and decides hard-error vs
    // soft-skip during sync. The backend has no field for it.
    expect(decl.schemaExplicit).toBeUndefined()
    // ⛔ A FILE-BASED QUERY EMITS NO `source` AT ALL. `entities/{schema}/` is the
    // pool and `schema:` addresses it, so a path here would be a derivation shipped
    // as though it were authored — and the pull would then write it into the
    // author's file, which is exactly the `deferred:` defect. `source:` stays in the
    // vocabulary for REMOTE (`url:`) queries, whose address nothing local derives.
    expect(decl.path).toBeUndefined()
    expect(decl.source).toBeUndefined()
    // CONTROL — the decl is really here and carries its modelled fields, so the two
    // absences above are about withholding rather than an empty record.
    expect(decl.schema).toBe('@std/person')
    expect(decl.limit).toBe(10)
  })
})

describe('pull — an unmodelled decl field returns to the authored file', () => {
  it('preserves a wire field the projection does not model', () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'collections'), { recursive: true })
    writeFileSync(join(src, 'site.yml'), "name: T\nfoundation: '@acme/base@1.0.0'\n")

    const document = {
      queries: [
        {
          name: 'members',
          source: { path: 'collections/members' },
          schema: '@std/person',
          detail_url: '/api/members/{slug}',
          displayHeading: 'Our Team'
        }
      ]
    }

    declarationsToQueriesYml({ document, siteRoot: src })
    const written = yaml.load(readFileSync(join(src, 'queries.yml'), 'utf8'))
    const decl = written.members // a BARE map — no root key

    // The subject.
    expect(decl.displayHeading).toBe('Our Team')

    // CONTROL — a stored field the projection CONSUMES rather than preserves. If
    // preservation were a blanket copy, a stored `detail_url` would be written back
    // under some spelling — and `detailUrl:` stops the build since 2026-09-13.
    expect(decl.detailUrl).toBeUndefined()
    expect(decl.detail_url).toBeUndefined()
  })
})

describe('round trip — push(pull(x)) is a fixed point on an unmodelled field', () => {
  it('survives file → wire → file → wire', async () => {
    const src = makeSite(withUnmodelled)

    const first = await siteProjectToDocument(src)
    declarationsToQueriesYml({ document: first, siteRoot: src })
    const second = await siteProjectToDocument(src)

    const a = first.queries.find((c) => c.name === 'members')
    const b = second.queries.find((c) => c.name === 'members')

    expect(b.displayHeading).toBe('Our Team')
    // The whole record is stable, not just the field under test — a round trip that
    // preserves the subject while perturbing its neighbours is not a fixed point.
    expect(b).toEqual(a)
  })
})
