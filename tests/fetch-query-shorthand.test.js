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

describe('the wire crossing', () => {
  // ⚠️ The WIRE field is still `collection` — it is on the backend's Model and not
  // framework's to rename. The two names cross at the authoring boundary, the same
  // way `detailUrl` and `detail_url` do.
  it('recognizes the wire spelling as the query shape', () => {
    expect(fetchShapeOf({ collection: 'articles', path: '/data/articles.json' })).toBe('query')
    expect(fetchShapeOf({ query: 'articles' })).toBe('query')
    expect(fetchShapeOf({ path: '/data/x.json' })).toBe('source')
  })

  it('writes the wire spelling back as the AUTHORING one', () => {
    // ⛔ Writing `collection:` back would author a file the build now refuses —
    // a pull would produce a site that cannot build.
    expect(
      authorableFetch({ collection: 'members', path: '/data/members.json', schema: 'members' })
    ).toEqual({ query: 'members', schema: 'members' })
  })

  it('CONTROL — a source-shaped fetch keeps its path, which the author wrote', () => {
    const source = { path: '/data/custom.json', schema: 'things' }
    expect(authorableFetch(source)).toEqual(source)
  })
})
