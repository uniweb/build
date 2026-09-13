import {
  parseFetchConfig,
  executeFetch,
  stripBuildOnlyFetchKeys,
  mergeDataIntoContent,
  executeMultipleFetches,
  applySort,
  applyPostProcessing,
  toFetchList,
} from '../src/site/data-fetcher.js'
// Derived, never re-spelled — the convention is pinned once, in
// `@uniweb/core`'s tests/data-paths.test.js.
import { queryDataUrl } from '@uniweb/core'

describe('parseFetchConfig — a binding names a query (ruled 2026-09-13)', () => {
  it('returns null for falsy input', () => {
    expect(parseFetchConfig(null)).toBeNull()
    expect(parseFetchConfig(undefined)).toBeNull()
    expect(parseFetchConfig('')).toBeNull()
  })

  describe('⭐ a string is a query name', () => {
    it('`fetch: team` is `fetch: { query: team }`', () => {
      // ⛔ `as` only. `schema` was emitted alongside it as a compatibility
      // duplicate until 2026-09-02; the duplicate is gone and one name is the
      // point of the rename.
      expect(parseFetchConfig('team')).toEqual(parseFetchConfig({ query: 'team' }))
      expect(parseFetchConfig('team')).toMatchObject({ query: 'team', path: queryDataUrl('team'), as: 'team', merge: false })
    })

    it('and in a list, one binding per name', () => {
      const result = parseFetchConfig(['team', { query: 'articles', limit: 3 }])
      expect(result.map((c) => [c.query, c.as, c.limit])).toEqual([['team', 'team', undefined], ['articles', 'articles', 3]])
    })

    it('⛔ a path is not a query name — `/data/…` is the file the build generates, never authored', () => {
      // A string that was a path until 2026-09-13 — `fetch: /data/team.json` — now
      // says what to write instead, rather than looking for a query of that name.
      expect(() => parseFetchConfig('/data/team.json', 'pages/team/page.yml')).toThrow(
        /pages\/team\/page\.yml: `fetch: "\/data\/team\.json"` — a fetch names a query, and a query name is not a path\. .*`query: team`/
      )
      expect(() => parseFetchConfig(['team', 'data/b.yml'])).toThrow(/a query name is not a path/)
    })
  })

  describe('an object binding', () => {
    it('carries its adaptations and the compiled address derived from the query', () => {
      expect(parseFetchConfig({ query: 'articles', as: 'posts', where: { a: 1 }, sort: 'date desc', limit: 5, merge: true })).toEqual({
        query: 'articles',
        path: queryDataUrl('articles'),
        as: 'posts',
        prerender: undefined,
        merge: true,
        where: { a: 1 },
        sort: 'date desc',
        limit: 5,
        current: undefined,
        detailPage: undefined,
      })
    })

    it('`prerender` only when authored — its default depends on the query, which the resolver knows', () => {
      expect(parseFetchConfig({ query: 'a' }).prerender).toBeUndefined()
      expect(parseFetchConfig({ query: 'a', prerender: false }).prerender).toBe(false)
      expect(parseFetchConfig({ query: 'a', prerender: true }).prerender).toBe(true)
    })

    it('⛔ a binding with no query stops the build', () => {
      expect(() => parseFetchConfig({ as: 'x', limit: 3 }, 'x.md')).toThrow(/x\.md: a fetch names a query/)
      expect(() => parseFetchConfig({}, 'x.md')).toThrow(/a fetch names a query/)
    })

    it('⛔ `path:` is refused — beside a query it says to delete the line', () => {
      expect(() => parseFetchConfig({ path: '/data/team.json', as: 'team' }, 'x.md')).toThrow(/`path:` is not a fetch key .*Declare a query/)
      expect(() => parseFetchConfig({ query: 'team', path: '/data/team.json' }, 'x.md')).toThrow(/`path:` is not a fetch key .*Delete the `path:` line/)
    })

    it('⛔ `url:`, `method:`, `body:` and `transform:` belong on an external query', () => {
      expect(() => parseFetchConfig({ url: 'https://api.test/team', as: 'team' }, 'x.md')).toThrow(/`url:` belongs on an external query, not on a fetch/)
      for (const key of ['method', 'body', 'transform']) {
        expect(() => parseFetchConfig({ query: 'team', [key]: 'x' }, 'x.md')).toThrow(new RegExp(`\`${key}:\` belongs on an external query`))
      }
    })

    it('⛔ `detail:` is retired, naming `current:` and `record:`', () => {
      expect(() => parseFetchConfig({ query: 'team', detail: 'rest' }, 'x.md')).toThrow(/`detail:` is retired\. .*current:.*record: \{ url: … \}/)
    })

    it('returns null for non-object, non-string input', () => {
      expect(parseFetchConfig(123)).toBeNull()
      expect(parseFetchConfig(true)).toBeNull()
    })
  })

  /**
   * ⭐ **A list means "fetch each."** It used to keep `[0]` and drop the rest
   * silently — an author writing `data: [team, articles]` got one dataset and a
   * section rendering empty, with no warning at any stage.
   */
  describe('a list of declarations', () => {
    it('parses every entry, in order', () => {
      const result = parseFetchConfig([{ query: 'team' }, { query: 'articles' }])
      expect(result.map((c) => c.as)).toEqual(['team', 'articles'])
    })

    it('gives each entry its own address', () => {
      const result = parseFetchConfig([{ query: 'team' }, { query: 'articles' }])
      expect(new Set(result.map((c) => c.path)).size).toBe(2)
    })

    it('⛔ collapses a ONE-entry list to an object', () => {
      // The shape reflects the cardinality of the RESULT, not of the syntax, so
      // no declaration that resolves to a single fetch changes shape.
      const result = parseFetchConfig([{ query: 'team' }])
      expect(Array.isArray(result)).toBe(false)
      expect(result.as).toBe('team')
    })

    it('returns null for an empty list', () => {
      expect(parseFetchConfig([])).toBeNull()
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

  it('⛔ does NOT read the retired `schema:` spelling — no alias, by ruling (2026-09-03)', () => {
    // Pinned in the negative: a fetch authored as `schema: posts` binds to the query
    // name, not to `posts`. One name, no alias; a pre-rename file is re-authored.
    expect(parseFetchConfig({ query: 'articles', schema: 'posts' }).as).toBe('articles')
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

  it('applies sort only', () => {
    const result = applyPostProcessing(items, { sort: 'order asc' })
    expect(result.map(i => i.name)).toEqual(['B', 'C', 'A'])
  })

  it('applies limit only', () => {
    const result = applyPostProcessing(items, { limit: 2 })
    expect(result).toHaveLength(2)
  })

  it('applies where, sort, and limit in order', () => {
    const result = applyPostProcessing(items, {
      where: { active: true },
      sort: 'order asc',
      limit: 1,
    })
    // where: A, C (active=true); sort order asc: C(2), A(3); limit 1: C
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

  it('names the offending key', () => {
    parseFetchConfig({ query: 'x', wehre: { a: 1 } })
    expect(messages().some((m) => m.includes('"wehre"'))).toBe(true)
    parseFetchConfig({ query: 'articles', recursive: true })
    expect(messages().some((m) => m.includes('"recursive"'))).toBe(true)
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
    parseFetchConfig({ query: 'x', as: 'y', merge: true, prerender: false, detailPage: 'page:abc' })
    parseFetchConfig({ query: 'articles', current: 'exclude', limit: 3 }, 'pages/a/[slug]/related.md', { level: 'section' })
    expect(messages().filter((m) => m.includes('unrecognized key'))).toHaveLength(0)
  })

  it('the retired `filter:` DSL is now an unrecognized key, reported', () => {
    // `filter:` (the legacy DSL string) was removed 2026-09-05. It is no longer
    // a recognized fetch key, so it is reported like any other unknown one —
    // loud, not silently honoured.
    parseFetchConfig({ query: 'articles', filter: 'a == 1' })
    expect(messages().filter((m) => m.includes('unrecognized key')).length).toBeGreaterThan(0)
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

  it('warns and names the key the binding actually bound to', () => {
    // The diagnostic value is the SECOND name: the author can see at a glance
    // that the binding landed under the query's name, not under `posts`.
    parseFetchConfig({ query: 'articles', schema: 'posts' })
    const m = messages().find((x) => x.includes("'schema: posts'"))
    expect(m).toBeDefined()
    expect(m).toContain('content.data.articles')
    expect(m).toContain("Write 'as: posts'")
  })

  it('warns even when the query name happens to match, because the next edit breaks it', () => {
    parseFetchConfig({ query: 'team', schema: 'team' })
    expect(messages().some((m) => m.includes("'schema: team'"))).toBe(true)
  })

  it('does not ALSO report it as an unrecognized key', () => {
    // It has a specific message; the generic one would understate it and double
    // the noise. This is what RETIRED_FETCH_KEYS buys — the key is still dropped.
    parseFetchConfig({ query: 'x', schema: 'y' })
    expect(messages().filter((m) => m.includes('unrecognized key'))).toHaveLength(0)
  })

  it('reports once per distinct (written → bound) pair', () => {
    parseFetchConfig({ query: 'a', schema: 'x' })
    parseFetchConfig({ query: 'a', schema: 'x' })
    parseFetchConfig({ query: 'b', schema: 'x' })
    expect(messages().filter((m) => m.includes("'schema: x'"))).toHaveLength(2)
  })

  it('stays silent on `as:` and on a queries-declaration `schema:`', () => {
    // The control. `schema:` on a `queries:` entry is a different, CURRENT key —
    // the Model ref — and never reaches this parser. Warning on `as:` would make
    // the build unusable while every assertion above still passed.
    parseFetchConfig({ query: 'team', as: 'team' })
    parseFetchConfig({ query: 'articles', as: 'posts' })
    expect(messages().filter((m) => m.includes('is retired as the binding key'))).toHaveLength(0)
  })
})

describe('parseFetchConfig — `refine` and its alias `inherit` are retired for `current:` (2026-09-13)', () => {
  // Same treatment as `collection:`, for the same reason: warned-and-ignored, a
  // `{ refine: true, limit: 3 }` falls through to the source shape, finds no
  // location, and resolves to null — a silently empty block.
  it('stops the build and names `current:`', () => {
    expect(() => parseFetchConfig({ refine: true, detail: false, limit: 3 }, 'pages/a/[slug]/related.md')).toThrow(
      /pages\/a\/\[slug\]\/related\.md: `refine: true` is retired\. .*current: exclude/
    )
    expect(() => parseFetchConfig({ inherit: true, limit: 3 })).toThrow(/`inherit: true` is retired\. .*current:/)
  })

  it('`current:` takes only, exclude or include', () => {
    expect(() => parseFetchConfig({ query: 'a', current: 'others' }, 'x.md', { level: 'section' })).toThrow(/write `only`, `exclude` or `include`/)
    expect(parseFetchConfig({ query: 'a', current: 'include' }, 'x.md', { level: 'section' })).toMatchObject({ query: 'a', current: 'include' })
  })

  it('`current:` sits on a section\'s binding — a page, folder or site binding stops the build', () => {
    expect(() => parseFetchConfig({ query: 'a', current: 'exclude' }, 'pages/a/page.yml', { level: 'page' })).toThrow(
      /pages\/a\/page\.yml: `current:` is read on a section's binding, not on a page's/
    )
    expect(() => parseFetchConfig({ query: 'a', current: 'only' }, 'site.yml', { level: 'site' })).toThrow(/not on a site's/)
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
