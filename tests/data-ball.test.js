import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleDataBall, collectBallAssets, rewriteBallAssets } from '../src/site/index.js'

// The static-data ball: the schema-less subset of dist/data/** + the whole
// dist/_search/** index, parsed into one JSON doc for the composite deploy.

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

describe('assembleDataBall', () => {
  it('bundles only the schema-less collections data + the whole search index, as parsed JSON', async () => {
    w('data/articles.json', JSON.stringify([{ slug: 'a' }])) // schema-backed → excluded
    w('data/notes.json', JSON.stringify([{ slug: 'n1' }])) // schema-less → included
    w('data/notes/n1.json', JSON.stringify({ slug: 'n1', body: 'x' })) // deferred per-record → included
    w('_search/en/pages.json', JSON.stringify({ type: 'pages', items: [] }))

    const ball = await assembleDataBall(dist, ['notes'])

    expect(Object.keys(ball.data).sort()).toEqual(['notes.json', 'notes/n1.json'])
    expect(ball.data['notes.json']).toEqual([{ slug: 'n1' }]) // a parsed value, not a string
    expect(ball.data['articles.json']).toBeUndefined() // schema-backed → entity lane, not the ball
    expect(ball.search['en/pages.json']).toEqual({ type: 'pages', items: [] })
  })

  it('search is NOT filtered by schema presence (baked over all content)', async () => {
    w('data/articles.json', JSON.stringify([{ slug: 'a' }]))
    w('_search/en/articles.json', JSON.stringify({ type: 'collection' }))

    const ball = await assembleDataBall(dist, []) // no schema-less collections
    expect(ball.data).toEqual({}) // nothing schema-less → no data
    expect(ball.search['en/articles.json']).toEqual({ type: 'collection' }) // search still bundled
  })

  it('returns null when there is nothing to deliver (no schema-less data, no search)', async () => {
    w('data/articles.json', JSON.stringify([{ slug: 'a' }])) // schema-backed only, no search
    expect(await assembleDataBall(dist, [])).toBeNull()
    expect(await assembleDataBall(dist)).toBeNull() // default schemalessNames = []
  })
})

describe('collectBallAssets', () => {
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
    expect(collectBallAssets(ball).sort()).toEqual(['/collections/notes/t.webp', '/images/cover.png'])
  })

  it('returns [] for a null ball or a ball with no local media', () => {
    expect(collectBallAssets(null)).toEqual([])
    expect(collectBallAssets({ data: { 'n.json': [{ slug: 'x', url: 'https://e/y.png' }] }, search: {} })).toEqual([])
  })
})

describe('rewriteBallAssets', () => {
  it('swaps every mapped local ref for its serve URL, leaves unmapped + non-refs untouched, and is pure', () => {
    const ball = {
      data: { 'notes.json': [{ image: '/images/cover.png', also: '/images/missing.png', body: 'text' }] },
      search: { 'en/pages.json': { thumb: '/images/cover.png' } },
    }
    const map = { '/images/cover.png': 'https://cdn/dist/abc/base.png' }
    const out = rewriteBallAssets(ball, map)

    expect(out.data['notes.json'][0].image).toBe('https://cdn/dist/abc/base.png') // mapped → rewritten
    expect(out.search['en/pages.json'].thumb).toBe('https://cdn/dist/abc/base.png') // search rewritten too
    expect(out.data['notes.json'][0].also).toBe('/images/missing.png') // unmapped → preserved
    expect(out.data['notes.json'][0].body).toBe('text') // non-ref → untouched
    expect(ball.data['notes.json'][0].image).toBe('/images/cover.png') // pure — input unchanged
  })

  it('returns the ball untouched for an empty map or a null ball', () => {
    const ball = { data: {}, search: {} }
    expect(rewriteBallAssets(ball, {})).toBe(ball)
    expect(rewriteBallAssets(null, { a: 'b' })).toBeNull()
  })
})
