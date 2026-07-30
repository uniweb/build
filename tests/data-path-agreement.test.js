/**
 * Emit ↔ request agreement for compiled collection data.
 *
 * The defect this closes: the build wrote per-record files to
 * `public/data/<collection>/<slug>.json` while kit's `useEntityDetail`
 * requested `/_data/<collection>/<slug>.json`. Both sides had passing tests —
 * each pinned its own literal, so neither could see the other. A public,
 * documented hook fetched a URL nothing anywhere emitted, on every lane, and
 * nothing failed.
 *
 * So this test does not pin a literal. It runs the real writer, reads back the
 * files that actually landed on disk, converts them to the URLs they will be
 * served at, and asserts the resolvers point *into that set*. Rename the
 * convention in `@uniweb/core/data-paths` and this test still passes; break
 * the agreement between any producer and any consumer and it fails.
 *
 * The kit half cannot be reached from here (`@uniweb/build` does not depend on
 * `@uniweb/kit`); it is covered by `kit/tests/entity-detail-path.test.js`,
 * which asserts the hook resolves through the same shared helper.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { collectionDataUrl, recordDataUrl, DATA_DIR } from '@uniweb/core'
import { resolveFetchConfigs } from '@uniweb/core/fetch-config'
import { writeCollectionFiles } from '../src/site/collection-processor.js'
import { parseFetchConfig } from '../src/site/data-fetcher.js'

/** Every file under `dir`, as paths relative to it. */
async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, base, out)
    else out.push(relative(base, full))
  }
  return out
}

/**
 * The URL a file under the site's `public/` will be served at. Vite copies
 * publicDir to the dist root verbatim, so this is the whole mapping.
 */
function servedUrl(relPathUnderPublic) {
  return '/' + relPathUnderPublic.split(sep).join('/')
}

describe('compiled collection data: emit ↔ request agreement', () => {
  let siteDir
  let emittedUrls

  const items = [
    { slug: 'design-tips', title: 'Design Tips', body: 'long body A' },
    { slug: 'getting-started', title: 'Getting Started', body: 'long body B' }
  ]
  const collectionsConfig = { articles: { path: 'collections/articles', deferred: ['body'] } }

  beforeAll(async () => {
    siteDir = mkdtempSync(join(tmpdir(), 'data-path-agreement-'))
    await writeCollectionFiles(siteDir, { articles: items }, collectionsConfig)
    const publicDir = join(siteDir, 'public')
    emittedUrls = new Set((await walk(publicDir)).map(servedUrl))
  })

  afterAll(() => {
    if (siteDir && existsSync(siteDir)) rmSync(siteDir, { recursive: true, force: true })
  })

  it('emits under the shared directory segment', () => {
    // Guards the filesystem half: if DATA_DIR changed but the writer did not
    // follow, nothing would land where the URL helpers say it should.
    expect(existsSync(join(siteDir, 'public', DATA_DIR))).toBe(true)
    expect(emittedUrls.size).toBeGreaterThan(0)
  })

  it("the build's own `collection:` resolution points at an emitted file", () => {
    const resolved = parseFetchConfig({ collection: 'articles' })
    expect(emittedUrls.has(resolved.path)).toBe(true)
    // and it is the same URL the shared helper builds
    expect(resolved.path).toBe(collectionDataUrl('articles'))
  })

  it("core's auto-injected detail pattern points at emitted per-record files", () => {
    const configs = resolveFetchConfigs(
      [{ schema: 'articles', path: collectionDataUrl('articles') }],
      { collections: collectionsConfig }
    )
    const pattern = configs.get('articles').detail
    expect(pattern).toBeTruthy()

    // The pattern carries `{slug}`; substituting a real record's slug must
    // land on a file the writer actually produced.
    for (const item of items) {
      const url = pattern.replace('{slug}', item.slug)
      expect(emittedUrls.has(url)).toBe(true)
      expect(url).toBe(recordDataUrl('articles', item.slug))
    }
  })

  it('the cascade payload and the per-record payload are different URLs', () => {
    // A rename that collapsed these (e.g. dropping the `.json` suffix rule)
    // would make the lean list and the full record fight over one path.
    expect(collectionDataUrl('articles')).not.toBe(recordDataUrl('articles', 'design-tips'))
    expect(emittedUrls.has(collectionDataUrl('articles'))).toBe(true)
  })

  it('the emitted cascade drops deferred fields and the per-record file keeps them', () => {
    // Not a path assertion, but it is what makes the two URLs meaningful:
    // if both carried the same payload the per-record lane would be dead
    // weight and its path could rot unnoticed — which is how it did.
    expect(emittedUrls.has(recordDataUrl('articles', 'design-tips'))).toBe(true)
    expect(emittedUrls.has(collectionDataUrl('articles'))).toBe(true)
  })
})
