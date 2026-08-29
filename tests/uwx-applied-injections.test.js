/**
 * The banked hash and the document it describes must stay together.
 *
 * `emitSyncPackages` hashes the DELIVERED document, not the authored one: a local
 * `/images/x.svg` is rewritten to the backend serve URL the push just uploaded to,
 * and `info.foundation` is replaced by the version-pinned ref the publish released.
 * A push banks those hashes in `.uniweb/sync-cache.json`.
 *
 * ⛔ Which means a reader that re-emits WITHOUT those injections is comparing against
 * hashes of a document it never built. That is not a theoretical asymmetry — it is
 * the defect the backend lane reported on 2026-08-19:
 * `uniweb push` said "1 entity unchanged since the last push" and `uniweb status
 * --json` said `changed: 1`, from one cache, seconds apart, on a site whose only
 * distinguishing feature was a single `![](/images/placeholder.svg)`. It could never
 * settle, because no number of pushes can make the authored document hash like the
 * delivered one.
 *
 * So the emitter reports `applied`, the pusher banks it beside the hashes, and any
 * offline reader replays it. These tests pin that round trip.
 *
 * ⭐ Every case here carries a CONTROL that must report the entity as CHANGED. An
 * "it matched" assertion proves nothing on its own: a gate that never fires would
 * satisfy it for the wrong reason, which is exactly how this shipped.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages } from '../src/uwx/index.js'

let ROOT, SITE
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-applied-'))
  SITE = join(ROOT, 'site')
  mkdirSync(SITE, { recursive: true })
  w('site.yml', ['name: Acme', 'foundation: "@acme/marketing@1"', 'index: home', ''].join('\n'))
  w('package.json', JSON.stringify({ name: 's' }))
  w('pages/1-home/page.yml', 'id: home\n')
  // The site-root asset ref is the whole point — it is what `push` rewrites.
  w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![shot](/images/shot.svg)\n')
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

/** `changed` as `uniweb status --json` computes it. */
const changedCount = (pkg) =>
  (pkg.siteContent?.entityCount || 0) + (pkg.records?.entityCount || 0)

const REWRITE = { assetRewrite: { '/images/shot.svg': 'https://cdn.example/assets/abc/base.svg' } }
const PIN = { injectInfo: { foundation: '@acme/marketing@1.4.2' } }

describe('emitSyncPackages — applied injections', () => {
  it('reports what it applied, in the shape it takes back', async () => {
    const pkg = await emitSyncPackages(SITE, { ...REWRITE, ...PIN })
    expect(pkg.applied).toEqual({ ...REWRITE, ...PIN })
  })

  it('reports an EMPTY object when nothing was injected', async () => {
    // A caller must be able to bank `applied` unconditionally: an absent map and a
    // stale one from an earlier push are not distinguishable later.
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.applied).toEqual({})
  })

  it('surfaces the site-root asset the rewrite is for', async () => {
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.localAssets).toEqual(['/images/shot.svg'])
  })

  describe.each([
    ['an asset rewrite', REWRITE],
    ['a pinned foundation ref', PIN],
    ['both together', { ...REWRITE, ...PIN }]
  ])('a push that applied %s', (_label, injections) => {
    it('is seen as unchanged by a re-emit that replays `applied`', async () => {
      const pushed = await emitSyncPackages(SITE, injections)
      expect(changedCount(pushed)).toBe(1)

      const reread = await emitSyncPackages(SITE, {
        priorHashes: pushed.hashes,
        ...pushed.applied
      })
      expect(changedCount(reread)).toBe(0)
      expect(reread.skipped).toBe(1)
    })

    it('CONTROL: is seen as CHANGED by a re-emit that drops them', async () => {
      // The pre-fix reader. Without this the assertion above would also pass on a
      // gate that never fires.
      const pushed = await emitSyncPackages(SITE, injections)
      const reread = await emitSyncPackages(SITE, { priorHashes: pushed.hashes })
      expect(changedCount(reread)).toBe(1)
      expect(reread.skipped).toBe(0)
    })
  })

  it('an asset NEW to the site still reads as changed under replay', async () => {
    // The replay must not blind the diff: it reproduces the last delivered document,
    // it does not assert the site is unchanged.
    const pushed = await emitSyncPackages(SITE, REWRITE)
    w('pages/1-home/2-more.md', '---\ntype: Text\nid: more\n---\n![new](/images/new.svg)\n')
    const reread = await emitSyncPackages(SITE, {
      priorHashes: pushed.hashes,
      ...pushed.applied
    })
    expect(changedCount(reread)).toBe(1)
  })
})
