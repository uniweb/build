// A decl field framework does not model must survive the round trip.
//
// ⛔ WHY. The `collections` decl's field set is the BACKEND's — this document
// mirrors the `@uniweb/site-content` Model (`uwx/site.js:11`, `:309`) — and their
// reconcile replaces an item's `data` WHOLESALE, at no field grain. So an allowlist
// in our emitter does not merely fail to send an unmodelled field: it DESTROYS
// whatever was stored under it, on every push, silently.
//
// ⚠️ Measured 2026-08-29 (channel framework-backend-2dfa): the Model declares
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
import { siteProjectToDocument, declarationsToCollectionsYml } from '../src/uwx/index.js'

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
    const decl = doc.collections.find((c) => c.name === 'members')

    // The subject.
    expect(decl.displayHeading).toBe('Our Team')

    // CONTROL — a field the emitter DOES model, on the same record. Without this
    // the assertion above would pass identically if the whole decl were passed
    // through raw, which would be a different (and wrong) implementation.
    expect(decl.limit).toBe(10)
    expect(decl.schema).toBe('@std/person')
  })

  it('⛔ a RENAMED field rides once, under its wire spelling only', async () => {
    // ⚠️ The control the first draft of this change lacked. `detailUrl` is emitted
    // as `detail_url`, so a pass-through that skips keys "already in data" does not
    // recognize it and emits BOTH — a duplicate, on the one field whose name differs
    // across the seam. The two controls above (`limit`, `schema`) keep their names,
    // so neither could have caught it. A rename needs a renamed field to test it.
    const src = makeSite(
"members:\n  schema: '@std/person'\n  detailUrl: /api/m/{slug}\n"
    )

    const doc = await siteProjectToDocument(src)
    const decl = doc.collections.find((c) => c.name === 'members')

    expect(decl.detail_url).toBe('/api/m/{slug}')
    expect(decl.detailUrl).toBeUndefined()
  })

  it('⛔ withholds framework-local fields the Model has no slot for', async () => {
    // `route:` is a REAL authored field — `parseCollectionConfig` reads it and
    // `collectItems` composes each item link as `<route>/<slug>` — but it is
    // framework's, not the Model's. Sending it would push build-time config into a
    // store that validates writes against a declared schema.
    const src = makeSite(
"members:\n  schema: '@std/person'\n  route: /team\n"
    )

    const doc = await siteProjectToDocument(src)
    const decl = doc.collections.find((c) => c.name === 'members')

    expect(decl.route).toBeUndefined()
    // CONTROL — the record exists and carries its modelled fields, so the assertion
    // above is about withholding and not about an empty result.
    expect(decl.schema).toBe('@std/person')
  })

  it('⛔ still withholds framework-local keys — pass-through is not a raw dump', async () => {
    const src = makeSite(withUnmodelled)

    const doc = await siteProjectToDocument(src)
    const decl = doc.collections.find((c) => c.name === 'members')

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
      collections: [
        {
          name: 'members',
          source: { path: 'collections/members' },
          schema: '@std/person',
          detail_url: '/api/members/{slug}',
          displayHeading: 'Our Team'
        }
      ]
    }

    declarationsToCollectionsYml({ document, siteRoot: src })
    const written = yaml.load(readFileSync(join(src, 'queries.yml'), 'utf8'))
    const decl = written.members // a BARE map — no root key

    // The subject.
    expect(decl.displayHeading).toBe('Our Team')

    // CONTROL — a modelled field that is RENAMED on the way in. If preservation
    // were implemented as a blanket copy, `detail_url` would survive under its wire
    // spelling and the file would carry both keys.
    expect(decl.detailUrl).toBe('/api/members/{slug}')
    expect(decl.detail_url).toBeUndefined()
  })
})

describe('round trip — push(pull(x)) is a fixed point on an unmodelled field', () => {
  it('survives file → wire → file → wire', async () => {
    const src = makeSite(withUnmodelled)

    const first = await siteProjectToDocument(src)
    declarationsToCollectionsYml({ document: first, siteRoot: src })
    const second = await siteProjectToDocument(src)

    const a = first.collections.find((c) => c.name === 'members')
    const b = second.collections.find((c) => c.name === 'members')

    expect(b.displayHeading).toBe('Our Team')
    // The whole record is stable, not just the field under test — a round trip that
    // preserves the subject while perturbing its neighbours is not a fixed point.
    expect(b).toEqual(a)
  })
})
