import {
  parseFetchConfig,
  executeFetch,
  mergeDataIntoContent,
  executeMultipleFetches,
  applyFilter,
  applySort,
  applyPostProcessing,
  toFetchList,
} from '../src/site/data-fetcher.js'
// Derived, never re-spelled — the convention is pinned once, in
// `@uniweb/core`'s tests/data-paths.test.js.
import { queryDataUrl } from '@uniweb/core'

describe('parseFetchConfig', () => {
  it('returns null for falsy input', () => {
    expect(parseFetchConfig(null)).toBeNull()
    expect(parseFetchConfig(undefined)).toBeNull()
    expect(parseFetchConfig('')).toBeNull()
  })

  describe('simple string input', () => {
    it('parses simple path string', () => {
      // ⛔ `as` only. `schema` was emitted alongside it as a compatibility
      // duplicate until 2026-09-02; the duplicate is gone and one name is the
      // point of the rename.
      expect(parseFetchConfig('/data/team.json')).toEqual({
        path: '/data/team.json',
        url: undefined,
        as: 'team',
        prerender: true,
        merge: false,
        transform: undefined,
      })
    })

    it('infers schema from filename', () => {
      expect(parseFetchConfig('/data/team-members.json').as).toBe('team-members')
      expect(parseFetchConfig('/api/events.yaml').as).toBe('events')
      expect(parseFetchConfig('/public/config.yml').as).toBe('config')
    })

    it('handles paths without extension', () => {
      expect(parseFetchConfig('/api/users').as).toBe('users')
    })

    it('handles deep paths', () => {
      const result = parseFetchConfig('/data/archive/2024/posts.json')
      expect(result.path).toBe('/data/archive/2024/posts.json')
      expect(result.as).toBe('posts')
    })
  })

  describe('full config object', () => {
    it('parses config with path', () => {
      // ⭐ An author's `schema:` is normalized to `as` AT THE BOUNDARY and not
      // echoed back. That input spelling predates the 2026-09-02 rename and is
      // content on someone's disk, so it is still read — but nothing inside
      // carries two names for one thing.
      const config = {
        path: '/data/team.json',
        schema: 'person',
        prerender: false,
        merge: true,
      }
      expect(parseFetchConfig(config)).toEqual({
        path: '/data/team.json',
        url: undefined,
        as: 'person',
        prerender: false,
        merge: true,
        transform: undefined,
      })
    })

    it('parses config with url', () => {
      const config = {
        url: 'https://api.example.com/team',
        schema: 'team',
      }
      const result = parseFetchConfig(config)
      expect(result.url).toBe('https://api.example.com/team')
      expect(result.as).toBe('team')
      expect(result.prerender).toBe(false)
      expect(result.merge).toBe(false)
    })

    it('parses config with transform', () => {
      const config = {
        url: 'https://api.example.com/response',
        schema: 'items',
        transform: 'data.items',
      }
      const result = parseFetchConfig(config)
      expect(result.url).toBe('https://api.example.com/response')
      expect(result.as).toBe('items')
      expect(result.prerender).toBe(false)
      expect(result.merge).toBe(false)
      expect(result.transform).toBe('data.items')
    })

    it('defaults prerender to true for path configs', () => {
      const config = { path: '/data/team.json' }
      expect(parseFetchConfig(config).prerender).toBe(true)
    })

    it('defaults prerender to false for url configs', () => {
      const config = { url: 'https://api.example.com/team' }
      expect(parseFetchConfig(config).prerender).toBe(false)
    })

    it('respects explicit prerender: true for url configs', () => {
      const config = { url: 'https://api.example.com/team', prerender: true }
      expect(parseFetchConfig(config).prerender).toBe(true)
    })

    it('infers schema from path when not provided', () => {
      const config = { path: '/data/articles.json' }
      expect(parseFetchConfig(config).as).toBe('articles')
    })

    it('infers schema from url when not provided', () => {
      const config = { url: 'https://api.example.com/events' }
      expect(parseFetchConfig(config).as).toBe('events')
    })

    it('returns null when neither path nor url provided', () => {
      expect(parseFetchConfig({ schema: 'test' })).toBeNull()
      expect(parseFetchConfig({})).toBeNull()
    })

    it('applies default values', () => {
      const config = { path: '/data/test.json' }
      const result = parseFetchConfig(config)
      expect(result.prerender).toBe(true)
      expect(result.merge).toBe(false)
    })
  })

  it('returns null for non-object, non-string input', () => {
    expect(parseFetchConfig(123)).toBeNull()
    expect(parseFetchConfig(true)).toBeNull()
  })

  /**
   * ⭐ **A list means "fetch each."** It used to keep `[0]` and drop the rest
   * silently — an author writing `data: [team, articles]` got one dataset and a
   * section rendering empty, with no warning at any stage.
   *
   * These pin the two properties that keep that from coming back by another
   * route: every entry survives, and a list that resolves to ONE fetch is
   * indistinguishable from having declared it singly.
   */
  describe('a list of declarations', () => {
    it('parses every entry, in order', () => {
      const result = parseFetchConfig([{ query: 'team' }, { query: 'articles' }])
      expect(result.map((c) => c.as)).toEqual(['team', 'articles'])
    })

    it('gives each entry its own address', () => {
      // The failure this guards against is one config overwriting another's
      // path and both keys resolving to the same file.
      const result = parseFetchConfig([{ query: 'team' }, { query: 'articles' }])
      expect(new Set(result.map((c) => c.path)).size).toBe(2)
    })

    it('⛔ collapses a ONE-entry list to an object', () => {
      // The shape reflects the cardinality of the RESULT, not of the syntax, so
      // no declaration that resolves to a single fetch changes shape. That is
      // what keeps this from being a silent break for every existing consumer
      // reading `fetch.path`.
      const result = parseFetchConfig([{ query: 'team' }])
      expect(Array.isArray(result)).toBe(false)
      expect(result.as).toBe('team')
    })

    it('drops unparseable entries rather than emitting holes', () => {
      // A null in the list would reach consumers as `cfg.path` on undefined.
      const result = parseFetchConfig([{ query: 'team' }, { nothing: true }, { query: 'x' }])
      expect(result.map((c) => c.as)).toEqual(['team', 'x'])
    })

    it('returns null when nothing in the list parses', () => {
      expect(parseFetchConfig([{ nothing: true }])).toBeNull()
      expect(parseFetchConfig([])).toBeNull()
    })

    it('accepts the string form inside a list, as it does alone', () => {
      const result = parseFetchConfig(['/data/a.json', '/data/b.json'])
      expect(result.map((c) => c.path)).toEqual(['/data/a.json', '/data/b.json'])
    })
  })

  describe('toFetchList', () => {
    it('normalizes all three shapes to a list', () => {
      // ⛔ The reason every consumer must use this: `cfg.path` on an array is
      // `undefined`, which reads as "no address" rather than as an error.
      expect(toFetchList(null)).toEqual([])
      expect(toFetchList({ as: 'a' })).toHaveLength(1)
      expect(toFetchList([{ as: 'a' }, { as: 'b' }])).toHaveLength(2)
    })
  })

  describe('collection reference', () => {
    it('parses collection shorthand', () => {
      const config = { query: 'articles' }
      const result = parseFetchConfig(config)

      expect(result.path).toBe(queryDataUrl('articles'))
      expect(result.as).toBe('articles')
      expect(result.prerender).toBe(true)
    })

    it('parses collection with limit', () => {
      const config = { query: 'articles', limit: 3 }
      const result = parseFetchConfig(config)

      expect(result.path).toBe(queryDataUrl('articles'))
      expect(result.limit).toBe(3)
    })

    it('parses collection with sort', () => {
      const config = { query: 'articles', sort: 'date desc' }
      const result = parseFetchConfig(config)

      expect(result.sort).toBe('date desc')
    })

    it('parses collection with filter', () => {
      const config = { query: 'articles', filter: 'tags contains featured' }
      const result = parseFetchConfig(config)

      expect(result.filter).toBe('tags contains featured')
    })

    it('allows schema override', () => {
      const config = { query: 'articles', schema: 'posts' }
      const result = parseFetchConfig(config)

      expect(result.as).toBe('posts')
    })

    it('parses collection with all options', () => {
      const config = {
        query: 'articles',
        limit: 5,
        sort: 'date desc',
        filter: 'published != false',
        schema: 'posts',
      }
      const result = parseFetchConfig(config)

      expect(result.path).toBe(queryDataUrl('articles'))
      expect(result.as).toBe('posts')
      expect(result.limit).toBe(5)
      expect(result.sort).toBe('date desc')
      expect(result.filter).toBe('published != false')
    })
  })

  describe('post-processing options on path/url', () => {
    it('parses path with limit', () => {
      const config = { path: '/data/items.json', limit: 10 }
      const result = parseFetchConfig(config)

      expect(result.path).toBe('/data/items.json')
      expect(result.limit).toBe(10)
    })

    it('parses url with sort and filter', () => {
      const config = {
        url: 'https://api.example.com/items',
        sort: 'order asc',
        filter: 'active == true',
      }
      const result = parseFetchConfig(config)

      expect(result.sort).toBe('order asc')
      expect(result.filter).toBe('active == true')
    })
  })
})

describe('mergeDataIntoContent', () => {
  it('returns original content when fetchedData is null/undefined', () => {
    const content = { data: { existing: [1, 2] } }
    expect(mergeDataIntoContent(content, null, 'test')).toBe(content)
    expect(mergeDataIntoContent(content, undefined, 'test')).toBe(content)
  })

  it('returns original content when schema is empty', () => {
    const content = { data: { existing: [1, 2] } }
    expect(mergeDataIntoContent(content, [3, 4], '')).toBe(content)
    expect(mergeDataIntoContent(content, [3, 4], null)).toBe(content)
  })

  describe('replace mode (default)', () => {
    it('replaces data under schema key', () => {
      const content = { data: { team: [{ name: 'Local' }] } }
      const fetched = [{ name: 'Remote' }]

      const result = mergeDataIntoContent(content, fetched, 'team', false)

      expect(result.data.team).toEqual([{ name: 'Remote' }])
    })

    it('creates new schema key if not exists', () => {
      const content = { data: {} }
      const fetched = [{ name: 'New' }]

      const result = mergeDataIntoContent(content, fetched, 'team', false)

      expect(result.data.team).toEqual([{ name: 'New' }])
    })

    it('creates data object if not exists', () => {
      const content = {}
      const fetched = [{ name: 'New' }]

      const result = mergeDataIntoContent(content, fetched, 'team', false)

      expect(result.data.team).toEqual([{ name: 'New' }])
    })

    it('preserves other data keys', () => {
      const content = { data: { team: [1], config: { a: 1 } } }
      const fetched = [2]

      const result = mergeDataIntoContent(content, fetched, 'team', false)

      expect(result.data.team).toEqual([2])
      expect(result.data.config).toEqual({ a: 1 })
    })

    it('does not mutate original content', () => {
      const content = { data: { team: [1] } }
      const fetched = [2]

      const result = mergeDataIntoContent(content, fetched, 'team', false)

      expect(content.data.team).toEqual([1])
      expect(result.data.team).toEqual([2])
    })
  })

  describe('merge mode', () => {
    it('concatenates arrays', () => {
      const content = { data: { team: [{ name: 'Local' }] } }
      const fetched = [{ name: 'Remote' }]

      const result = mergeDataIntoContent(content, fetched, 'team', true)

      expect(result.data.team).toEqual([
        { name: 'Local' },
        { name: 'Remote' },
      ])
    })

    it('shallow merges objects', () => {
      const content = { data: { config: { a: 1, b: 2 } } }
      const fetched = { b: 3, c: 4 }

      const result = mergeDataIntoContent(content, fetched, 'config', true)

      expect(result.data.config).toEqual({ a: 1, b: 3, c: 4 })
    })

    it('uses fetched when types differ (array vs object)', () => {
      const content = { data: { team: [1, 2] } }
      const fetched = { name: 'object' }

      const result = mergeDataIntoContent(content, fetched, 'team', true)

      expect(result.data.team).toEqual({ name: 'object' })
    })

    it('handles merge when existing data is missing', () => {
      const content = { data: {} }
      const fetched = [{ name: 'New' }]

      const result = mergeDataIntoContent(content, fetched, 'team', true)

      expect(result.data.team).toEqual([{ name: 'New' }])
    })
  })
})

describe('executeFetch', () => {
  it('returns null data for null config', async () => {
    const result = await executeFetch(null)
    expect(result.data).toBeNull()
  })

  it('returns empty array when file not found', async () => {
    const config = {
      path: '/nonexistent/file.json',
      schema: 'test',
    }
    const result = await executeFetch(config, { siteRoot: '/tmp' })

    expect(result.data).toEqual([])
    expect(result.error).toContain('not found')
  })
})

describe('executeMultipleFetches', () => {
  it('returns empty map for empty configs', async () => {
    const result = await executeMultipleFetches([])
    expect(result.size).toBe(0)
  })

  it('returns empty map for null configs', async () => {
    const result = await executeMultipleFetches(null)
    expect(result.size).toBe(0)
  })
})

describe('applyFilter', () => {
  const items = [
    { name: 'A', active: true, tags: ['featured', 'new'], score: 10 },
    { name: 'B', active: false, tags: ['old'], score: 5 },
    { name: 'C', active: true, tags: ['featured'], score: 8 },
  ]

  it('returns original items if no filter', () => {
    expect(applyFilter(items, null)).toBe(items)
    expect(applyFilter(items, '')).toBe(items)
  })

  it('filters by equality (==)', () => {
    const result = applyFilter(items, 'active == true')
    expect(result).toHaveLength(2)
    expect(result.map(i => i.name)).toEqual(['A', 'C'])
  })

  it('filters by inequality (!=)', () => {
    const result = applyFilter(items, 'active != true')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('B')
  })

  it('filters by greater than (>)', () => {
    const result = applyFilter(items, 'score > 5')
    expect(result).toHaveLength(2)
    expect(result.map(i => i.name)).toEqual(['A', 'C'])
  })

  it('filters by less than (<)', () => {
    const result = applyFilter(items, 'score < 10')
    expect(result).toHaveLength(2)
    expect(result.map(i => i.name)).toEqual(['B', 'C'])
  })

  it('filters by contains (array)', () => {
    const result = applyFilter(items, 'tags contains featured')
    expect(result).toHaveLength(2)
    expect(result.map(i => i.name)).toEqual(['A', 'C'])
  })

  it('filters by contains (string)', () => {
    const strItems = [
      { name: 'hello world' },
      { name: 'foo bar' },
    ]
    const result = applyFilter(strItems, 'name contains world')
    expect(result).toHaveLength(1)
  })

  it('handles non-array input gracefully', () => {
    expect(applyFilter(null, 'a == b')).toBeNull()
    expect(applyFilter('not array', 'a == b')).toBe('not array')
  })
})

describe('applySort', () => {
  const items = [
    { name: 'C', order: 3, date: '2025-01-03' },
    { name: 'A', order: 1, date: '2025-01-01' },
    { name: 'B', order: 2, date: '2025-01-02' },
  ]

  it('returns original items if no sort', () => {
    expect(applySort(items, null)).toBe(items)
    expect(applySort(items, '')).toBe(items)
  })

  it('sorts ascending by default', () => {
    const result = applySort(items, 'order')
    expect(result.map(i => i.name)).toEqual(['A', 'B', 'C'])
  })

  it('sorts ascending explicitly', () => {
    const result = applySort(items, 'order asc')
    expect(result.map(i => i.name)).toEqual(['A', 'B', 'C'])
  })

  it('sorts descending', () => {
    const result = applySort(items, 'order desc')
    expect(result.map(i => i.name)).toEqual(['C', 'B', 'A'])
  })

  it('sorts by string field', () => {
    const result = applySort(items, 'name asc')
    expect(result.map(i => i.name)).toEqual(['A', 'B', 'C'])
  })

  it('sorts by date string', () => {
    const result = applySort(items, 'date desc')
    expect(result.map(i => i.name)).toEqual(['C', 'B', 'A'])
  })

  it('sorts by multiple fields', () => {
    const multiItems = [
      { category: 'B', order: 2 },
      { category: 'A', order: 2 },
      { category: 'A', order: 1 },
    ]
    const result = applySort(multiItems, 'category asc, order asc')
    expect(result).toEqual([
      { category: 'A', order: 1 },
      { category: 'A', order: 2 },
      { category: 'B', order: 2 },
    ])
  })

  it('does not mutate original array', () => {
    const original = [...items]
    applySort(items, 'order desc')
    expect(items).toEqual(original)
  })
})

describe('applyPostProcessing', () => {
  const items = [
    { name: 'A', order: 3, active: true },
    { name: 'B', order: 1, active: false },
    { name: 'C', order: 2, active: true },
  ]

  it('returns original data if no post-processing options', () => {
    expect(applyPostProcessing(items, {})).toBe(items)
  })

  it('returns non-array data unchanged', () => {
    const obj = { foo: 'bar' }
    expect(applyPostProcessing(obj, { limit: 1 })).toBe(obj)
  })

  it('applies filter only', () => {
    const result = applyPostProcessing(items, { filter: 'active == true' })
    expect(result).toHaveLength(2)
  })

  it('applies sort only', () => {
    const result = applyPostProcessing(items, { sort: 'order asc' })
    expect(result.map(i => i.name)).toEqual(['B', 'C', 'A'])
  })

  it('applies limit only', () => {
    const result = applyPostProcessing(items, { limit: 2 })
    expect(result).toHaveLength(2)
  })

  it('applies filter, sort, and limit in order', () => {
    const result = applyPostProcessing(items, {
      filter: 'active == true',
      sort: 'order asc',
      limit: 1,
    })
    // Filter: A, C (active=true)
    // Sort by order asc: C (order=2), A (order=3)
    // Limit 1: C
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('C')
  })
})

describe('parseFetchConfig — unrecognized keys are reported, not swallowed', () => {
  // The parser reads an allowlist and builds a new object, so an unrecognized
  // key vanishes with no trace in the output. A typo and a capability the
  // author believed existed are then indistinguishable from having written
  // nothing at all — which is how `type:`/`recursive:` were discovered to be
  // silently discarded rather than unsupported.
  let warn
  beforeEach(async () => {
    const mod = await import('../src/site/data-fetcher.js')
    mod._resetUnknownFetchKeyWarnings()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  const messages = () => warn.mock.calls.map((c) => String(c[0]))

  it('names the offending key on a path/url declaration', () => {
    parseFetchConfig({ path: '/data/x.json', schema: 'x', wehre: { a: 1 } })
    expect(messages().some((m) => m.includes('"wehre"'))).toBe(true)
  })

  it('names it on a collection declaration too', () => {
    parseFetchConfig({ query: 'articles', recursive: true })
    expect(messages().some((m) => m.includes('"recursive"'))).toBe(true)
  })

  it('names it on a refine declaration too', () => {
    parseFetchConfig({ refine: true, limit: 2, bogus: 1 })
    expect(messages().some((m) => m.includes('"bogus"'))).toBe(true)
  })

  it('lists what IS recognized, so the message is actionable', () => {
    parseFetchConfig({ query: 'articles', nope: 1 })
    const m = messages().find((x) => x.includes('"nope"'))
    expect(m).toContain('query')
    expect(m).toContain('where')
  })

  it('reports once per key, not once per record', () => {
    parseFetchConfig({ query: 'a', recursive: true })
    parseFetchConfig({ query: 'b', recursive: true })
    expect(messages().filter((m) => m.includes('"recursive"'))).toHaveLength(1)
  })

  it('stays silent on every recognized shape', () => {
    // The control. Without it, a warn-on-everything bug would pass every
    // assertion above while making the build unusable.
    parseFetchConfig({ query: 'articles', where: { a: 1 }, sort: 'date desc', limit: 3 })
    parseFetchConfig({ path: '/data/x.json', schema: 'x', transform: 'data.items', merge: true })
    parseFetchConfig({ url: 'https://example.com/api', schema: 'x', prerender: false })
    parseFetchConfig({ refine: true, detail: false, limit: 3 })
    expect(messages().filter((m) => m.includes('unrecognized key'))).toHaveLength(0)
  })

  it('does not confuse a dropped key with a deprecated one', () => {
    // `filter:` is recognized-but-deprecated; it must warn about deprecation,
    // never about being unrecognized.
    parseFetchConfig({ query: 'articles', filter: 'a == 1' })
    expect(messages().filter((m) => m.includes('unrecognized key'))).toHaveLength(0)
  })
})

describe('parseFetchConfig — the retired inherit: alias is an error', () => {
  // Same treatment as `collection:`, for the same reason: warned-and-ignored,
  // `{ inherit: true, limit: 3 }` falls through to the source shape, finds no
  // location, and resolves to null — a silently empty block.
  it('stops the build and names the current spelling', () => {
    expect(() => parseFetchConfig({ inherit: true, limit: 3 })).toThrow(/inherit: true/)
    expect(() => parseFetchConfig({ inherit: true, limit: 3 })).toThrow(/refine: true/)
  })

  it('refine: true still parses as a refinement — the control', () => {
    expect(parseFetchConfig({ refine: true, limit: 3 })).toMatchObject({ refine: true, limit: 3 })
  })
})
