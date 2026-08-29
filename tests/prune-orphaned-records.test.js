/**
 * Per-record files must not outlive the records that produced them.
 *
 * `public/data/` is persistent and normally committed, so anything written
 * there survives until something removes it — and nothing did. Unpublishing a
 * record (`published: false`, honoured automatically by the collection
 * processor) or deleting its source file dropped it from the cascade listing,
 * so it vanished from the site, while `<name>/<slug>.json` stayed on disk
 * carrying the full body. It then got committed and deployed. An author who
 * unpublishes has every reason to think the content is gone; it remained
 * fetchable at a URL that was public a moment earlier.
 *
 * The first test is that bug. The rest are the guardrails on a routine that
 * deletes files, and they matter as much: `public/data/` is also a documented
 * place to hand-author JSON (`docs/reference/data-fetching.md`), so an
 * over-eager prune would destroy exactly the files the overwrite hazard
 * already threatens.
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DATA_DIR } from '@uniweb/core'
import { writeQueryFiles } from '../src/site/query-processor.js'

const DEFERRED = { articles: { path: 'collections/articles', deferred: ['body'] } }

const rec = (slug, extra = {}) => ({ slug, title: slug, body: `body of ${slug}`, ...extra })

/** Filenames under public/data/<name>/, sorted. */
async function recordFiles(siteDir, name) {
  const dir = join(siteDir, 'public', DATA_DIR, name)
  if (!existsSync(dir)) return []
  return (await readdir(dir)).sort()
}

describe('per-record file pruning', () => {
  let siteDir

  beforeEach(() => {
    siteDir = mkdtempSync(join(tmpdir(), 'prune-records-'))
  })

  afterEach(() => {
    if (siteDir && existsSync(siteDir)) rmSync(siteDir, { recursive: true, force: true })
  })

  it('removes the file for a record that is gone on the next build', async () => {
    await writeQueryFiles(
      siteDir,
      { articles: [rec('public-post'), rec('secret-draft')] },
      DEFERRED
    )
    expect(await recordFiles(siteDir, 'articles')).toEqual([
      'public-post.json',
      'secret-draft.json'
    ])

    // The author unpublishes `secret-draft`. The collection processor drops it
    // upstream of here, so this build simply receives one fewer record — which
    // is also what deleting the source file looks like.
    await writeQueryFiles(siteDir, { articles: [rec('public-post')] }, DEFERRED)

    expect(await recordFiles(siteDir, 'articles')).toEqual(['public-post.json'])
    expect(
      existsSync(join(siteDir, 'public', DATA_DIR, 'articles', 'secret-draft.json'))
    ).toBe(false)
  })

  it('clears the directory when a collection stops declaring deferred:', async () => {
    await writeQueryFiles(siteDir, { articles: [rec('a'), rec('b')] }, DEFERRED)
    expect(await recordFiles(siteDir, 'articles')).toEqual(['a.json', 'b.json'])

    // Without deferred: nothing will ever write this directory again, so every
    // file in it is stale from this point on.
    await writeQueryFiles(
      siteDir,
      { articles: [rec('a'), rec('b')] },
      { articles: { path: 'collections/articles' } }
    )

    expect(await recordFiles(siteDir, 'articles')).toEqual([])
  })

  it('leaves records that are still present untouched', async () => {
    await writeQueryFiles(siteDir, { articles: [rec('keep'), rec('drop')] }, DEFERRED)
    await writeQueryFiles(siteDir, { articles: [rec('keep')] }, DEFERRED)

    const kept = JSON.parse(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(siteDir, 'public', DATA_DIR, 'articles', 'keep.json'), 'utf8')
      )
    )
    expect(kept.slug).toBe('keep')
    expect(kept.body).toBe('body of keep')
  })

  it('reconciles the whole directory, not just .json', async () => {
    // `public/data/` is build output and nothing else — `collections/` is the
    // only supported way to provide structured data. So anything in a record
    // directory that this run did not write is stale by definition, whatever
    // its extension. (An earlier revision of this test asserted the opposite,
    // from a docs section that invited hand-authoring here; that section is
    // gone and the pattern with it.)
    await writeQueryFiles(siteDir, { articles: [rec('a')] }, DEFERRED)
    const dir = join(siteDir, 'public', DATA_DIR, 'articles')
    writeFileSync(join(dir, 'NOTES.md'), 'stale')
    mkdirSync(join(dir, 'attachments'))
    writeFileSync(join(dir, 'attachments', 'paper.pdf'), 'stale')

    await writeQueryFiles(siteDir, { articles: [] }, DEFERRED)

    expect(existsSync(join(dir, 'NOTES.md'))).toBe(false)
    expect(existsSync(join(dir, 'attachments'))).toBe(false)
    expect(existsSync(join(dir, 'a.json'))).toBe(false)
  })

  it('refuses a collection name that escapes the output directory', async () => {
    // The routine deletes and `name` arrives from site.yml, so a traversing
    // name would make the sweep somebody else's files. Guarded rather than
    // trusted.
    const outside = join(siteDir, 'public', 'sibling')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.json'), 'not in the output directory')

    await writeQueryFiles(siteDir, { '../sibling': [] }, {
      '../sibling': { path: 'collections/x', deferred: ['body'] }
    })

    expect(existsSync(join(outside, 'keep.json'))).toBe(true)
  })

  it('does not touch the cascade file or a sibling collection', async () => {
    await writeQueryFiles(
      siteDir,
      { articles: [rec('a')], team: [rec('alice')] },
      { ...DEFERRED, team: { path: 'collections/team', deferred: ['body'] } }
    )
    await writeQueryFiles(
      siteDir,
      { articles: [], team: [rec('alice')] },
      { ...DEFERRED, team: { path: 'collections/team', deferred: ['body'] } }
    )

    const dataDir = join(siteDir, 'public', DATA_DIR)
    // The cascade lives beside the directory, not in it — pruning must not
    // reach up a level.
    expect(existsSync(join(dataDir, 'articles.json'))).toBe(true)
    expect(await recordFiles(siteDir, 'team')).toEqual(['alice.json'])
  })

  it('is a no-op for a collection that never had per-record files', async () => {
    const plain = { articles: { path: 'collections/articles' } }
    await writeQueryFiles(siteDir, { articles: [rec('a')] }, plain)
    expect(existsSync(join(siteDir, 'public', DATA_DIR, 'articles.json'))).toBe(true)
    expect(await recordFiles(siteDir, 'articles')).toEqual([])
  })
})
