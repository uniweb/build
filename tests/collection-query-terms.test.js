// Every query term a collection declaration carries must actually be applied when
// the build materializes it.
//
// ⛔ WHY. `where:` is the canonical predicate; `filter:` is the deprecated string
// DSL it replaced. Until 2026-08-29 `parseQueryConfig` read `filter` and never
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
import { resolveQueriesConfig } from '../src/site/queries-config.js'
import { processQueries } from '../src/site/query-processor.js'

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
  w('records/post/a.md', '---\ntitle: A\ntier: gold\n---\n\nA\n')
  w('records/post/b.md', '---\ntitle: B\ntier: silver\n---\n\nB\n')
  const cfg = await resolveQueriesConfig(SITE)
  const out = await processQueries(SITE, cfg.declarations)
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

  it('sort: reorders', async () => {
    expect(await items('    sort: title desc\n')).toEqual(['B', 'A'])
  })

  it('⛔ limit: is NOT applied — every record the query selects compiles (ruled 2026-09-13)', async () => {
    // A `limit` is how many a list shows, and a binding may pick its own — more than
    // the query's included — so the runtime cuts each list (`@uniweb/core/fetch-config`).
    // This truncated until then, and a record past the limit had no detail page.
    expect(await items('    limit: 1\n')).toEqual(['A', 'B'])
  })

  it('where still narrows beside a limit — the limit changes nothing here', async () => {
    expect(await items('    where: { tier: silver }\n    limit: 1\n')).toEqual(await items('    where: { tier: silver }\n'))
    expect(await items('    where: { tier: silver }\n')).toEqual(['B'])
  })
})
