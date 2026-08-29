// Every query term a collection declaration carries must actually be applied when
// the build materializes it.
//
// ⛔ WHY. `where:` is the canonical predicate; `filter:` is the deprecated string
// DSL it replaced. Until 2026-08-29 `parseCollectionConfig` read `filter` and never
// `where`, and `collection-processor` applied only `filter` — so `where:` was
// parsed, put on the sync wire, stored, and NEVER APPLIED. The deprecated term
// worked and the canonical one did not.
//
// ⚠️ An author following current guidance got no error, no warning, and a site
// built from unfiltered data.
//
// ⭐ EVERY CASE HERE IS PAIRED WITH THE CONTROL ROW. The first version of this
// investigation concluded `where` DID work, from a fixture that returned one item
// with no predicate at all (`published: false` was being read as a draft). One
// number proves nothing: a term that narrows and a fixture that never had two
// records look identical.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCollectionsConfig } from '../src/site/collections-config.js'
import { processCollections } from '../src/site/collection-processor.js'

let ROOT
beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'query-terms-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

// Two records that differ on a NEUTRAL field. Deliberately not `published:`, which
// carries draft semantics and silently drops a record before any term runs.
async function items(declExtra) {
  const SITE = join(ROOT, `s${Math.random().toString(36).slice(2)}`)
  const w = (rel, body) => {
    const p = join(SITE, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  w('site.yml', `name: T\nfoundation: "@acme/base"\nqueries:\n  posts:\n    schema: "@/post"\n${declExtra}`)
  w('entities/post/a.md', '---\ntitle: A\ntier: gold\n---\n\nA\n')
  w('entities/post/b.md', '---\ntitle: B\ntier: silver\n---\n\nB\n')
  const cfg = await resolveCollectionsConfig(SITE)
  const out = await processCollections(SITE, cfg.declarations)
  return (out.posts?.items || out.posts || []).map((i) => i.title)
}

describe('collection query terms are applied at materialization', () => {
  it('CONTROL — with no terms, both records ship', async () => {
    // Every assertion below is a comparison against this. Without it, a term that
    // appears to narrow is indistinguishable from a fixture that never had two.
    expect(await items('')).toEqual(['A', 'B'])
  })

  it('⛔ where: — the canonical predicate, narrows', async () => {
    expect(await items('    where: { tier: gold }\n')).toEqual(['A'])
  })

  it('filter: — the deprecated expression, still narrows', async () => {
    expect(await items("    filter: 'tier == gold'\n")).toEqual(['A'])
  })

  it('sort: reorders', async () => {
    expect(await items('    sort: title desc\n')).toEqual(['B', 'A'])
  })

  it('limit: truncates', async () => {
    expect(await items('    limit: 1\n')).toEqual(['A'])
  })

  it('⛔ where + limit compose in the canonical order — narrow, THEN truncate', async () => {
    // The ordering assertion, and the reason order is not cosmetic. `tier: silver`
    // matches only B. Narrowing first yields [B]; limiting first would yield [] —
    // limit takes A, then the predicate rejects it. Two lanes evaluate these same
    // declarations (this one, and data-fetcher's page-level `fetch:`), so a
    // difference in order is a difference in RESULT.
    expect(await items('    where: { tier: silver }\n    limit: 1\n')).toEqual(['B'])
  })
})
