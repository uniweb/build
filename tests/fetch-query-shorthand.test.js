// `fetch: { query: X }` — the authoring shorthand, and the retired one.
//
// ⛔ THE RETIRED NAME MUST ERROR, NOT WARN. An unrecognized `fetch:` key is warned
// about and IGNORED, so `collection:` would fall through to the SOURCE shape, find
// neither `path` nor `url`, and return null — a page that renders with no data and
// nothing saying why. A silently empty result is worse than the old name simply
// continuing to work, which is why this is the one place the rename is enforced
// rather than merely applied.
import { parseFetchConfig, _resetUnknownFetchKeyWarnings } from '../src/site/data-fetcher.js'
import { authorableFetch, fetchShapeOf } from '../src/site/fetch-shapes.js'

beforeEach(() => _resetUnknownFetchKeyWarnings())

describe('the authoring shorthand', () => {
  it('resolves query: to the compiled artifact and the content.data key', () => {
    const cfg = parseFetchConfig({ query: 'articles', limit: 3, sort: 'date desc' })
    expect(cfg.path).toBe('/data/articles.json')
    expect(cfg.schema).toBe('articles')
    expect(cfg.limit).toBe(3)
    expect(cfg.sort).toBe('date desc')
  })

  it('lets an explicit schema override the query name', () => {
    expect(parseFetchConfig({ query: 'recent', schema: 'article' }).schema).toBe('article')
  })
})

describe('⛔ the retired name errors', () => {
  it('throws, naming the replacement and where to declare it', () => {
    expect(() => parseFetchConfig({ collection: 'articles' })).toThrow(/is retired/)
    expect(() => parseFetchConfig({ collection: 'articles' })).toThrow(/query: "articles"/)
    expect(() => parseFetchConfig({ collection: 'articles' })).toThrow(/queries\.yml/)
  })

  // ⛔ THE CASE THAT MAKES THIS A HARD ERROR RATHER THAN A WARNING. Verified, not
  // assumed: without the throw, the declaration falls to the source shape and
  // resolves to NULL — no path, no error, no data.
  it('would otherwise have resolved to nothing at all', () => {
    const { collection, ...withoutIt } = { collection: 'articles', limit: 3 }
    expect(parseFetchConfig(withoutIt)).toBeNull()
  })

  it('errors even when other keys would have made it look valid', () => {
    expect(() => parseFetchConfig({ collection: 'articles', schema: 'article', limit: 3 })).toThrow(
      /is retired/
    )
  })
})

describe('one name, end to end — no crossing', () => {
  // ⭐ `query` on the wire too. An earlier version emitted `collection` there, on
  // the belief that the field was the backend's to name. Measured otherwise:
  // framework already ships `transform`, `detailPage`, `merge` and `prerender`
  // inside this same object, which no backend could be validating — so `fetch` is
  // a blob they carry, and framework owns its vocabulary.
  it('recognizes the query shape', () => {
    expect(fetchShapeOf({ query: 'articles', path: '/data/articles.json' })).toBe('query')
    expect(fetchShapeOf({ path: '/data/x.json' })).toBe('source')
    // the retired name is not a shape — it is an error at parse
    expect(fetchShapeOf({ collection: 'articles' })).toBe('source')
  })

  it('drops the derived path, keeping what the author wrote', () => {
    expect(
      authorableFetch({ query: 'members', path: '/data/members.json', schema: 'members' })
    ).toEqual({ query: 'members', schema: 'members' })
  })

  it('CONTROL — a source-shaped fetch keeps its path, which the author wrote', () => {
    const source = { path: '/data/custom.json', schema: 'things' }
    expect(authorableFetch(source)).toEqual(source)
  })
})
