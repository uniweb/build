import {
  parseFetchConfig,
  executeFetch,
  mergeDataIntoContent,
  executeMultipleFetches,
  applyFilter,
  applySort,
  applyPostProcessing,
} from '../src/site/data-fetcher.js'

describe('parseFetchConfig', () => {
  it('returns null for falsy input', () => {
    expect(parseFetchConfig(null)).toBeNull()
    expect(parseFetchConfig(undefined)).toBeNull()
    expect(parseFetchConfig('')).toBeNull()
  })

  describe('simple string input', () => {
    it('parses simple path string', () => {
      expect(parseFetchConfig('/data/team.json')).toEqual({
        path: '/data/team.json',
        url: undefined,
        schema: 'team',
        prerender: true,
        merge: false,
        transform: undefined,
      })
    })

    it('infers schema from filename', () => {
      expect(parseFetchConfig('/data/team-members.json').schema).toBe('team-members')
      expect(parseFetchConfig('/api/events.yaml').schema).toBe('events')
      expect(parseFetchConfig('/public/config.yml').schema).toBe('config')
    })

    it('handles paths without extension', () => {
      expect(parseFetchConfig('/api/users').schema).toBe('users')
    })

    it('handles deep paths', () => {
      const result = parseFetchConfig('/data/archive/2024/posts.json')
      expect(result.path).toBe('/data/archive/2024/posts.json')
      expect(result.schema).toBe('posts')
    })
  })

  describe('full config object', () => {
    it('parses config with path', () => {
      const config = {
        path: '/data/team.json',
        schema: 'person',
        prerender: false,
        merge: true,
      }
      expect(parseFetchConfig(config)).toEqual({
        path: '/data/team.json',
        url: undefined,
        schema: 'person',
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
      expect(result.schema).toBe('team')
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
      expect(result.schema).toBe('items')
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
      expect(parseFetchConfig(config).schema).toBe('articles')
    })

    it('infers schema from url when not provided', () => {
      const config = { url: 'https://api.example.com/events' }
      expect(parseFetchConfig(config).schema).toBe('events')
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
    expect(parseFetchConfig(['array'])).toBeNull()
  })

  describe('collection reference', () => {
    it('parses collection shorthand', () => {
      const config = { collection: 'articles' }
      const result = parseFetchConfig(config)

      expect(result.path).toBe('/data/articles.json')
      expect(result.schema).toBe('articles')
      expect(result.prerender).toBe(true)
    })

    it('parses collection with limit', () => {
      const config = { collection: 'articles', limit: 3 }
      const result = parseFetchConfig(config)

      expect(result.path).toBe('/data/articles.json')
      expect(result.limit).toBe(3)
    })

    it('parses collection with sort', () => {
      const config = { collection: 'articles', sort: 'date desc' }
      const result = parseFetchConfig(config)

      expect(result.sort).toBe('date desc')
    })

    it('parses collection with filter', () => {
      const config = { collection: 'articles', filter: 'tags contains featured' }
      const result = parseFetchConfig(config)

      expect(result.filter).toBe('tags contains featured')
    })

    it('allows schema override', () => {
      const config = { collection: 'articles', schema: 'posts' }
      const result = parseFetchConfig(config)

      expect(result.schema).toBe('posts')
    })

    it('parses collection with all options', () => {
      const config = {
        collection: 'articles',
        limit: 5,
        sort: 'date desc',
        filter: 'published != false',
        schema: 'posts',
      }
      const result = parseFetchConfig(config)

      expect(result.path).toBe('/data/articles.json')
      expect(result.schema).toBe('posts')
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
