import {
  parseFetchConfig,
  executeFetch,
  stripBuildOnlyFetchKeys,
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
      const config = {
        path: '/data/team.json',
        as: 'person',
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
        as: 'team',
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
        as: 'items',
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

    it('allows an `as` override', () => {
      const config = { query: 'articles', as: 'posts' }
      const result = parseFetchConfig(config)

      expect(result.as).toBe('posts')
    })

    it('⛔ does NOT read the retired `schema:` spelling — no alias, by ruling (2026-09-03)', () => {
      // Pinned in the negative: a fetch authored as `schema: posts` binds to the query name, not to
      // `posts`. Restoring the fallback turns this red, which is the point — one name, no alias,
      // authored content included; a pre-rename file is re-authored, not translated.
      expect(parseFetchConfig({ query: 'articles', schema: 'posts' }).as).toBe('articles')
      expect(parseFetchConfig({ path: '/data/team.json', schema: 'person' }).as).toBe('team')
    })

    it('parses collection with all options', () => {
      const config = {
        query: 'articles',
        limit: 5,
        sort: 'date desc',
        filter: 'published != false',
        as: 'posts',
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

  // ⛔ Multi-key was honoured here and refused by the records door — the
  // language is single-key by ruling [Diego, 2026-09-04], and an authoring
  // error on the file lane fails at build time, where it is seen.
  it('refuses a multi-key sort at build time rather than honouring it on one lane', () => {
    const multiItems = [
      { category: 'B', order: 2 },
      { category: 'A', order: 2 },
      { category: 'A', order: 1 },
    ]
    expect(() => applySort(multiItems, 'category asc, order asc')).toThrow(/more than one key/)
  })

  it("accepts the door's `-field` spelling", () => {
    const result = applySort(items, '-order')
    expect(result.map((i) => i.order)).toEqual([3, 2, 1])
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
    parseFetchConfig({ path: '/data/x.json', as: 'x', transform: 'data.items', merge: true })
    parseFetchConfig({ url: 'https://example.com/api', as: 'x', prerender: false })
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

describe('parseFetchConfig — the retired `schema:` binding key is REPORTED, not swallowed', () => {
  // ⛔ The regression this exists to prevent, measured 2026-09-03. `schema:`
  // stopped being READ on 2026-09-02 (`e4fe077`) but was left on
  // RECOGNIZED_FETCH_KEYS, which exempted it from the unrecognized-key report.
  // So the one key guaranteed to appear in every pre-rename site was the one key
  // that vanished in total silence — and the data still arrived, under a
  // different `content.data` name, so the failure surfaced as an empty component
  // rather than as anything pointing at the fetch. Five of six sections in
  // `templates/dynamic` shipped broken this way.
  let warn
  beforeEach(async () => {
    const mod = await import('../src/site/data-fetcher.js')
    mod._resetRetiredSchemaWarnings()
    mod._resetUnknownFetchKeyWarnings()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  const messages = () => warn.mock.calls.map((c) => String(c[0]))

  it('warns on a source declaration and names the key it actually bound to', () => {
    // The diagnostic value is the SECOND name: the author can see at a glance
    // that `/data/site-config.json` bound to `site-config`, not to `config`.
    parseFetchConfig({ path: '/data/site-config.json', schema: 'config' })
    const m = messages().find((x) => x.includes("'schema: config'"))
    expect(m).toBeDefined()
    expect(m).toContain('content.data.site-config')
    expect(m).toContain("Write 'as: config'")
  })

  it('warns on a query declaration too', () => {
    parseFetchConfig({ query: 'articles', schema: 'posts' })
    const m = messages().find((x) => x.includes("'schema: posts'"))
    expect(m).toBeDefined()
    expect(m).toContain('content.data.articles')
  })

  it('says "(nothing)" when the inferred key is empty and the config is dropped', () => {
    // `https://randomuser.me/api/?results=6` → last segment `?results=6` → ''.
    // A falsy binding key is skipped by resolveFetchConfigs, so the fetch does
    // not merely land elsewhere — it does not land at all.
    const parsed = parseFetchConfig({ url: 'https://randomuser.me/api/?results=6', schema: 'donors' })
    expect(parsed.as).toBe('')
    expect(messages().some((m) => m.includes('content.data.(nothing)'))).toBe(true)
  })

  it('warns even when the inferred key happens to match, because the next edit breaks it', () => {
    parseFetchConfig({ path: '/data/team.json', schema: 'team' })
    expect(messages().some((m) => m.includes("'schema: team'"))).toBe(true)
  })

  it('does not ALSO report it as an unrecognized key', () => {
    // It has a specific message; the generic one would understate it and double
    // the noise. This is what RETIRED_FETCH_KEYS buys — the key is still dropped.
    parseFetchConfig({ path: '/data/x.json', schema: 'x' })
    expect(messages().filter((m) => m.includes('unrecognized key'))).toHaveLength(0)
  })

  it('reports once per distinct (written → bound) pair', () => {
    parseFetchConfig({ path: '/data/a.json', schema: 'x' })
    parseFetchConfig({ path: '/data/a.json', schema: 'x' })
    parseFetchConfig({ path: '/data/b.json', schema: 'x' })
    expect(messages().filter((m) => m.includes("'schema: x'"))).toHaveLength(2)
  })

  it('stays silent on `as:` and on a queries-declaration `schema:`', () => {
    // The control. `schema:` on a `queries:` entry is a different, CURRENT key —
    // the Model ref — and never reaches this parser. Warning on `as:` would make
    // the build unusable while every assertion above still passed.
    parseFetchConfig({ path: '/data/team.json', as: 'team' })
    parseFetchConfig({ query: 'articles', as: 'posts' })
    expect(messages().filter((m) => m.includes('is retired as the binding key'))).toHaveLength(0)
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

describe('stripBuildOnlyFetchKeys — `merge` never reaches a shipped payload', () => {
  const content = {
    config: { name: 'T', fetch: { path: '/data/site.json', as: 'site', merge: true } },
    pages: [
      {
        route: '/blog',
        fetch: [{ query: 'a', path: '/data/a.json', as: 'a', merge: false }, { query: 'b', path: '/data/b.json', as: 'b', prerender: true, merge: true }],
        sections: [
          { id: 's1', fetch: { path: '/data/s.json', as: 's', merge: true }, subsections: [
            { id: 's1a', fetch: { url: 'https://x/y', as: 'y', merge: true } },
          ] },
          { id: 's2' },
        ],
      },
    ],
    layouts: { default: { header: { sections: [{ id: 'h', fetch: { path: '/data/h.json', as: 'h', merge: true } }] } } },
    notFound: { route: '/404', sections: [{ id: 'n', fetch: { path: '/data/n.json', as: 'n', merge: false } }] },
    fetchedData: [{ config: { path: '/data/a.json', as: 'a', merge: false }, data: [] }],
  }

  const allFetches = (c) => {
    const out = []
    const take = (f) => { if (!f) return; for (const one of Array.isArray(f) ? f : [f]) out.push(one) }
    const walk = (sections) => { for (const s of sections || []) { take(s.fetch); walk(s.subsections) } }
    take(c.config?.fetch)
    for (const p of c.pages || []) { take(p.fetch); walk(p.sections) }
    for (const areas of Object.values(c.layouts || {})) for (const page of Object.values(areas)) walk(page.sections)
    walk(c.notFound?.sections)
    for (const e of c.fetchedData || []) take(e.config)
    return out
  }

  it('removes `merge` from every fetch declaration the payload carries', () => {
    const out = stripBuildOnlyFetchKeys(content)
    const fetches = allFetches(out)
    expect(fetches.length).toBe(8)
    expect(fetches.every((f) => !('merge' in f))).toBe(true)
  })

  it('keeps every other key, and the runtime-read ones in particular', () => {
    const out = stripBuildOnlyFetchKeys(content)
    expect(out.pages[0].fetch[1]).toEqual({ query: 'b', path: '/data/b.json', as: 'b', prerender: true })
    expect(out.config.fetch).toEqual({ path: '/data/site.json', as: 'site' })
  })

  it('does not mutate the input — the build still reads `merge` from its own copy', () => {
    const before = JSON.stringify(content)
    stripBuildOnlyFetchKeys(content)
    expect(JSON.stringify(content)).toBe(before)
  })

  it('shares untouched objects rather than cloning the site', () => {
    const out = stripBuildOnlyFetchKeys(content)
    expect(out.pages[0].sections[1]).toBe(content.pages[0].sections[1])
  })

  it('is a no-op shape-wise on a payload with no fetch at all', () => {
    const plain = { config: { name: 'T' }, pages: [{ route: '/', sections: [] }] }
    expect(stripBuildOnlyFetchKeys(plain)).toEqual(plain)
    expect(stripBuildOnlyFetchKeys(null)).toBeNull()
  })
})
