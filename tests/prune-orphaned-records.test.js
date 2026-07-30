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
import { writeCollectionFiles } from '../src/site/collection-processor.js'

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
    await writeCollectionFiles(
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
    await writeCollectionFiles(siteDir, { articles: [rec('public-post')] }, DEFERRED)

    expect(await recordFiles(siteDir, 'articles')).toEqual(['public-post.json'])
    expect(
      existsSync(join(siteDir, 'public', DATA_DIR, 'articles', 'secret-draft.json'))
    ).toBe(false)
  })

  it('clears the directory when a collection stops declaring deferred:', async () => {
    await writeCollectionFiles(siteDir, { articles: [rec('a'), rec('b')] }, DEFERRED)
    expect(await recordFiles(siteDir, 'articles')).toEqual(['a.json', 'b.json'])

    // Without deferred: nothing will ever write this directory again, so every
    // file in it is stale from this point on.
    await writeCollectionFiles(
      siteDir,
      { articles: [rec('a'), rec('b')] },
      { articles: { path: 'collections/articles' } }
    )

    expect(await recordFiles(siteDir, 'articles')).toEqual([])
  })

  it('leaves records that are still present untouched', async () => {
    await writeCollectionFiles(siteDir, { articles: [rec('keep'), rec('drop')] }, DEFERRED)
    await writeCollectionFiles(siteDir, { articles: [rec('keep')] }, DEFERRED)

    const kept = JSON.parse(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(siteDir, 'public', DATA_DIR, 'articles', 'keep.json'), 'utf8')
      )
    )
    expect(kept.slug).toBe('keep')
    expect(kept.body).toBe('body of keep')
  })

  it('does not touch non-JSON files a user put in the directory', async () => {
    await writeCollectionFiles(siteDir, { articles: [rec('a')] }, DEFERRED)
    const dir = join(siteDir, 'public', DATA_DIR, 'articles')
    writeFileSync(join(dir, 'NOTES.md'), 'hand-written, not ours to delete')
    mkdirSync(join(dir, 'attachments'))
    writeFileSync(join(dir, 'attachments', 'paper.pdf'), 'binary-ish')

    await writeCollectionFiles(siteDir, { articles: [] }, DEFERRED)

    expect(existsSync(join(dir, 'NOTES.md'))).toBe(true)
    expect(existsSync(join(dir, 'attachments', 'paper.pdf'))).toBe(true)
    expect(existsSync(join(dir, 'a.json'))).toBe(false)
  })

  it('does not touch the cascade file or a sibling collection', async () => {
    await writeCollectionFiles(
      siteDir,
      { articles: [rec('a')], team: [rec('alice')] },
      { ...DEFERRED, team: { path: 'collections/team', deferred: ['body'] } }
    )
    await writeCollectionFiles(
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
    await writeCollectionFiles(siteDir, { articles: [rec('a')] }, plain)
    expect(existsSync(join(siteDir, 'public', DATA_DIR, 'articles.json'))).toBe(true)
    expect(await recordFiles(siteDir, 'articles')).toEqual([])
  })
})
