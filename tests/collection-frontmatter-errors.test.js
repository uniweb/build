/**
 * A collection record that DECLARES frontmatter and fails to parse must not
 * degrade to an empty one.
 *
 * It used to warn and continue, which meant the record shipped: no title, no
 * date, no image, and a slug derived from its filename. Measured 2026-08-24 on
 * a real post — one unquoted colon in a description cost six fields and the
 * page's URL, and the warning naming no file sat on line 16 of 857 lines of
 * build output, nine lines above "Processed articles: 6 items".
 *
 * The distinction under test: a file with NO frontmatter is legitimate and
 * still returns {}. Only a declared-but-broken block is an error.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processCollections } from '../src/site/collection-processor.js'

const dirs = []

async function collectionWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'uniweb-coll-'))
  dirs.push(root)
  const dir = join(root, 'entities', 'article')
  await mkdir(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf8')
  }
  return root
}

const run = (root) =>
  processCollections(root, { articles: { schema: '@/article' } })

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

// The exact shape that bit: a colon-space inside an unquoted scalar.
const UNQUOTED_COLON = [
  '---',
  'title: A Post',
  'slug: a-post',
  'description: Building on a framework: everything hard is a website problem',
  '---',
  '',
  'Body text.',
].join('\n')

const VALID = [
  '---',
  'title: A Post',
  'slug: a-post',
  '---',
  '',
  'Body text.',
].join('\n')

describe('collection frontmatter that does not parse', () => {
  it('throws rather than silently dropping every field', async () => {
    const dir = await collectionWith({ 'post.md': UNQUOTED_COLON })

    await expect(
      run(dir)
    ).rejects.toThrow(/not valid YAML/)
  })

  it('names the file, so you can find it among many records', async () => {
    const dir = await collectionWith({ 'post.md': UNQUOTED_COLON })

    // The old message was "bad indentation of a mapping entry (4:72)" and named
    // nothing — useless in a collection of any size.
    await expect(
      run(dir)
    ).rejects.toThrow(/post\.md/)
  })

  it('explains the cost and the usual cause', async () => {
    const dir = await collectionWith({ 'post.md': UNQUOTED_COLON })

    const err = await run(dir).catch((e) => e)
    expect(err.message).toMatch(/EVERY field in it is lost/)
    expect(err.message).toMatch(/colon followed by a space/)
  })

  it('one bad record fails the collection rather than shipping a hollow entry', async () => {
    const dir = await collectionWith({ 'ok.md': VALID, 'broken.md': UNQUOTED_COLON })

    await expect(
      run(dir)
    ).rejects.toThrow(/broken\.md/)
  })
})

describe('collection records without frontmatter', () => {
  // The legitimate case the error must not swallow: absent is not broken.
  it('a body-only record still processes', async () => {
    const dir = await collectionWith({ 'plain.md': '# Just a heading\n\nAnd a body.\n' })

    const collections = await run(dir)
    const items = collections.articles

    expect(items).toHaveLength(1)
    expect(items[0].slug).toBe('plain')
  })

  it('an unterminated block is treated as no frontmatter, not as an error', async () => {
    const dir = await collectionWith({ 'open.md': '---\ntitle: never closed\n\nbody\n' })

    await expect(
      run(dir)
    ).resolves.toBeTruthy()
  })
})
