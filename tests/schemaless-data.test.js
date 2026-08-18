import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSchemalessData, collectSchemalessDataAssets, rewriteSchemalessDataAssets } from '../src/site/index.js'
// Derived, never re-spelled — the convention is pinned once, in
// `@uniweb/core`'s tests/data-paths.test.js.
import { DATA_DIR } from '@uniweb/core'

// The static-data ball: the schema-less subset of dist/data/**, parsed into one
// JSON doc for the composite deploy. Nothing else rides it.

let dist
function w(rel, body) {
  const p = join(dist, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'data-ball-'))
})
afterEach(() => rmSync(dist, { recursive: true, force: true }))

describe('collectSchemalessData', () => {
  it('bundles only the schema-less collections data, as parsed JSON', async () => {
    w(`${DATA_DIR}/articles.json`, JSON.stringify([{ slug: 'a' }])) // schema-backed → excluded
    w(`${DATA_DIR}/notes.json`, JSON.stringify([{ slug: 'n1' }])) // schema-less → included
    w(`${DATA_DIR}/notes/n1.json`, JSON.stringify({ slug: 'n1', body: 'x' })) // deferred per-record → included

    const ball = await collectSchemalessData(dist, ['notes'])

    expect(Object.keys(ball.data).sort()).toEqual(['notes.json', 'notes/n1.json'])
    expect(ball.data['notes.json']).toEqual([{ slug: 'n1' }]) // a parsed value, not a string
    expect(ball.data['articles.json']).toBeUndefined() // schema-backed → entity lane, not the ball
  })

  /**
   * A search index used to ride here. It no longer does, and this pins that,
   * because re-adding it would look like restoring symmetry with `data`.
   *
   * It was wrong for a reason `data` is not: only ONE of the two publishers
   * produced it. A CLI deploy did, a CMS publish did not, so a site's search
   * existed or vanished with whoever published last — the flicker rule. A host
   * that wants search derives it from the content it already stores, which is
   * the one input both lanes produce identically.
   */
  it('does NOT carry a search index, even when one is present in dist', async () => {
    w(`${DATA_DIR}/notes.json`, JSON.stringify([{ slug: 'n1' }]))
    w('_search/en/pages.json', JSON.stringify({ type: 'pages', items: [] }))
    w('search-index.json', JSON.stringify({ entries: [] }))

    const ball = await collectSchemalessData(dist, ['notes'])

    // The key is gone now, not merely empty. It shipped as `search: {}` for one
    // release so the consumer's relay stayed a well-formed shape while it still
    // declared the field; once the consumer retired it (2026-08-01), keeping an
    // empty key would have been sending into nothing. What must never survive
    // either way is CONTENT — that is what the two assertions below pin.
    expect(ball.search).toBeUndefined()
    expect(Object.keys(ball)).toEqual(['data'])
    expect(JSON.stringify(ball)).not.toContain('pages.json')
    expect(JSON.stringify(ball)).not.toContain('entries')
  })

  it('returns null when there is no schema-less data — a search index cannot keep it alive', async () => {
    w(`${DATA_DIR}/articles.json`, JSON.stringify([{ slug: 'a' }])) // schema-backed only
    w('_search/en/pages.json', JSON.stringify({ type: 'pages', items: [] })) // ignored now
    expect(await collectSchemalessData(dist, [])).toBeNull()
    expect(await collectSchemalessData(dist)).toBeNull() // default schemalessNames = []
  })
})

describe('collectSchemalessDataAssets', () => {
  it('collects site-root local media refs anywhere in the ball; skips remote + non-media; dedups', () => {
    const ball = {
      data: {
        'notes.json': [
          { slug: 'n1', image: '/images/cover.png' },
          { slug: 'n2', image: 'https://cdn.example/x.jpg' }, // remote → skip
          { slug: 'n3', image: '/images/cover.png' }, // dup → one entry
          { slug: 'n4', doc: '/data/notes.json' }, // .json is not media → skip
        ],
      },
      search: { 'en/pages.json': { thumb: '/collections/notes/t.webp' } },
    }
    expect(collectSchemalessDataAssets(ball).sort()).toEqual(['/collections/notes/t.webp', '/images/cover.png'])
  })

  it('returns [] for a null ball or a ball with no local media', () => {
    expect(collectSchemalessDataAssets(null)).toEqual([])
    expect(collectSchemalessDataAssets({ data: { 'n.json': [{ slug: 'x', url: 'https://e/y.png' }] }, search: {} })).toEqual([])
  })
})

describe('rewriteSchemalessDataAssets', () => {
  it('swaps every mapped local ref for its serve URL, leaves unmapped + non-refs untouched, and is pure', () => {
    const ball = {
      data: { 'notes.json': [{ image: '/images/cover.png', also: '/images/missing.png', body: 'text' }] },
      search: { 'en/pages.json': { thumb: '/images/cover.png' } },
    }
    const map = { '/images/cover.png': 'https://cdn/dist/abc/base.png' }
    const out = rewriteSchemalessDataAssets(ball, map)

    expect(out.data['notes.json'][0].image).toBe('https://cdn/dist/abc/base.png') // mapped → rewritten
    expect(out.search['en/pages.json'].thumb).toBe('https://cdn/dist/abc/base.png') // search rewritten too
    expect(out.data['notes.json'][0].also).toBe('/images/missing.png') // unmapped → preserved
    expect(out.data['notes.json'][0].body).toBe('text') // non-ref → untouched
    expect(ball.data['notes.json'][0].image).toBe('/images/cover.png') // pure — input unchanged
  })

  it('returns the ball untouched for an empty map or a null ball', () => {
    const ball = { data: {}, search: {} }
    expect(rewriteSchemalessDataAssets(ball, {})).toBe(ball)
    expect(rewriteSchemalessDataAssets(null, { a: 'b' })).toBeNull()
  })
})
