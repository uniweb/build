import {
  parseFetchConfig,
  executeFetch,
  mergeDataIntoContent,
  executeMultipleFetches,
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
      expect(parseFetchConfig(config)).toEqual({
        path: undefined,
        url: 'https://api.example.com/team',
        schema: 'team',
        prerender: true,
        merge: false,
        transform: undefined,
      })
    })

    it('parses config with transform', () => {
      const config = {
        url: 'https://api.example.com/response',
        schema: 'items',
        transform: 'data.items',
      }
      expect(parseFetchConfig(config)).toEqual({
        path: undefined,
        url: 'https://api.example.com/response',
        schema: 'items',
        prerender: true,
        merge: false,
        transform: 'data.items',
      })
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
