import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleDataBall } from '../src/site/index.js'

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
