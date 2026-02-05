import {
  extractItemName,
  parseWildcardArray,
  applyWildcardOrder,
  getDirectChildName
} from '../src/site/content-collector.js'

describe('extractItemName', () => {
  it('returns string as-is', () => {
    expect(extractItemName('hero')).toBe('hero')
  })

  it('returns key from single-key object', () => {
    expect(extractItemName({ features: ['a', 'b'] })).toBe('features')
  })

  it('returns null for multi-key object', () => {
    expect(extractItemName({ a: 1, b: 2 })).toBeNull()
  })

  it('returns null for null', () => {
    expect(extractItemName(null)).toBeNull()
  })

  it('returns null for non-string/non-object', () => {
    expect(extractItemName(42)).toBeNull()
    expect(extractItemName(undefined)).toBeNull()
  })
})

describe('parseWildcardArray', () => {
  it('returns null for empty array', () => {
    expect(parseWildcardArray([])).toBeNull()
  })

  it('returns null for non-array', () => {
    expect(parseWildcardArray(null)).toBeNull()
    expect(parseWildcardArray('hello')).toBeNull()
  })

  it('returns strict mode when no wildcard', () => {
    expect(parseWildcardArray(['a', 'b', 'c'])).toEqual({
      mode: 'strict', before: ['a', 'b', 'c'], after: []
    })
  })

  it('returns all mode when only wildcard', () => {
    expect(parseWildcardArray(['...'])).toEqual({
      mode: 'all', before: [], after: []
    })
  })

  it('handles trailing wildcard', () => {
    expect(parseWildcardArray(['a', 'b', '...'])).toEqual({
      mode: 'inclusive', before: ['a', 'b'], after: []
    })
  })

  it('handles leading wildcard', () => {
    expect(parseWildcardArray(['...', 'z'])).toEqual({
      mode: 'inclusive', before: [], after: ['z']
    })
  })

  it('handles middle wildcard', () => {
    expect(parseWildcardArray(['a', '...', 'z'])).toEqual({
      mode: 'inclusive', before: ['a'], after: ['z']
    })
  })

  it('handles object items', () => {
    const result = parseWildcardArray([{ features: ['a'] }, '...'])
    expect(result.mode).toBe('inclusive')
    expect(result.before).toEqual([{ features: ['a'] }])
  })

  it('handles multiple wildcards (first and last)', () => {
    // [a, ..., b, ..., c] → before=[a], after=[c] (b is between wildcards = rest)
    expect(parseWildcardArray(['a', '...', 'b', '...', 'c'])).toEqual({
      mode: 'inclusive', before: ['a'], after: ['c']
    })
  })
})

describe('applyWildcardOrder', () => {
  const items = [
    { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }
  ]

  it('returns items unchanged for null parsed', () => {
    expect(applyWildcardOrder(items, null)).toBe(items)
  })

  it('returns items unchanged for all mode', () => {
    const parsed = { mode: 'all', before: [], after: [] }
    expect(applyWildcardOrder(items, parsed)).toBe(items)
  })

  it('strict: listed first, then unlisted', () => {
    const parsed = { mode: 'strict', before: ['c', 'a'], after: [] }
    const result = applyWildcardOrder(items, parsed)
    expect(result.map(i => i.name)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('inclusive trailing: pinned first, rest after', () => {
    const parsed = { mode: 'inclusive', before: ['c'], after: [] }
    const result = applyWildcardOrder(items, parsed)
    expect(result.map(i => i.name)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('inclusive middle: before + rest + after', () => {
    const parsed = { mode: 'inclusive', before: ['c'], after: ['a'] }
    const result = applyWildcardOrder(items, parsed)
    expect(result.map(i => i.name)).toEqual(['c', 'b', 'd', 'a'])
  })

  it('inclusive leading: rest + after', () => {
    const parsed = { mode: 'inclusive', before: [], after: ['a'] }
    const result = applyWildcardOrder(items, parsed)
    expect(result.map(i => i.name)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('silently skips missing names', () => {
    const parsed = { mode: 'inclusive', before: ['x', 'c'], after: [] }
    const result = applyWildcardOrder(items, parsed)
    expect(result.map(i => i.name)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('handles all items pinned (no rest)', () => {
    const parsed = { mode: 'inclusive', before: ['d', 'c'], after: ['b', 'a'] }
    const result = applyWildcardOrder(items, parsed)
    expect(result.map(i => i.name)).toEqual(['d', 'c', 'b', 'a'])
  })
})

describe('getDirectChildName', () => {
  it('extracts root child name', () => {
    expect(getDirectChildName('/about', '/')).toBe('about')
  })

  it('extracts nested child name', () => {
    expect(getDirectChildName('/docs/guide', '/docs')).toBe('guide')
  })

  it('returns null for index page (same route)', () => {
    expect(getDirectChildName('/', '/')).toBeNull()
    expect(getDirectChildName('/docs', '/docs')).toBeNull()
  })

  it('returns null for grandchild', () => {
    expect(getDirectChildName('/docs/a/b', '/docs')).toBeNull()
  })

  it('returns null for unrelated route', () => {
    expect(getDirectChildName('/other', '/docs')).toBeNull()
  })

  it('returns null for null route', () => {
    expect(getDirectChildName(null, '/')).toBeNull()
  })
})
