import {
  extractItemName,
  parseWildcardArray,
  applyWildcardOrder,
  getDirectChildName,
  extractInlineChildren
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

describe('extractInlineChildren', () => {
  it('extracts inline_child_ref nodes and replaces with placeholders', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'inline_child_ref', attrs: { component: 'NetworkDiagram', alt: 'diagram', variant: 'compact' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
      ]
    }

    const result = extractInlineChildren(doc)

    // Should extract one inline child
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      refId: 'inline_0',
      type: 'NetworkDiagram',
      params: { variant: 'compact' },
      alt: 'diagram',
    })

    // Doc should be mutated: inline_child_ref → inline_child_placeholder
    expect(doc.content[1]).toEqual({
      type: 'inline_child_placeholder',
      attrs: { refId: 'inline_0' },
    })
    // Other nodes untouched
    expect(doc.content[0].type).toBe('heading')
    expect(doc.content[2].type).toBe('paragraph')
  })

  it('handles multiple @ refs with unique refIds', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'inline_child_ref', attrs: { component: 'Widget', alt: null } },
        { type: 'inline_child_ref', attrs: { component: 'Chart', alt: 'chart' } },
      ]
    }

    const result = extractInlineChildren(doc)

    expect(result).toHaveLength(2)
    expect(result[0].refId).toBe('inline_0')
    expect(result[0].type).toBe('Widget')
    expect(result[1].refId).toBe('inline_1')
    expect(result[1].type).toBe('Chart')
  })

  it('returns empty array when no @ refs exist', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Normal content' }] },
      ]
    }

    const result = extractInlineChildren(doc)
    expect(result).toHaveLength(0)
    // Doc unchanged
    expect(doc.content[0].type).toBe('paragraph')
  })

  it('returns empty array for null/missing content', () => {
    expect(extractInlineChildren(null)).toHaveLength(0)
    expect(extractInlineChildren({})).toHaveLength(0)
    expect(extractInlineChildren({ content: null })).toHaveLength(0)
  })

  it('params is empty object when no attributes besides component/alt', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'inline_child_ref', attrs: { component: 'Hero', alt: null } },
      ]
    }

    const result = extractInlineChildren(doc)
    expect(result[0].params).toEqual({})
  })
})
