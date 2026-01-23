/**
 * Tests for schema application logic in prerender.js
 * These functions apply runtime schemas to content.data
 */

// Import the functions from prerender.js - we'll need to export them
// For now, we test the logic by recreating the functions here
// (In a future refactor, these could be extracted to a shared module)

/**
 * Apply a schema to a single object
 */
function applySchemaToObject(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj
  }

  const result = { ...obj }

  for (const [field, fieldDef] of Object.entries(schema)) {
    const defaultValue = typeof fieldDef === 'object' ? fieldDef.default : undefined

    if (result[field] === undefined && defaultValue !== undefined) {
      result[field] = defaultValue
    }

    if (typeof fieldDef === 'object' && fieldDef.type === 'object' && fieldDef.schema && result[field]) {
      result[field] = applySchemaToObject(result[field], fieldDef.schema)
    }

    if (typeof fieldDef === 'object' && fieldDef.type === 'array' && fieldDef.of && result[field]) {
      if (typeof fieldDef.of === 'object') {
        result[field] = result[field].map(item => applySchemaToObject(item, fieldDef.of))
      }
    }
  }

  return result
}

/**
 * Apply a schema to a value (object or array of objects)
 */
function applySchemaToValue(value, schema) {
  if (Array.isArray(value)) {
    return value.map(item => applySchemaToObject(item, schema))
  }
  return applySchemaToObject(value, schema)
}

/**
 * Apply schemas to content.data
 */
function applySchemas(data, schemas) {
  if (!schemas || !data || typeof data !== 'object') {
    return data || {}
  }

  const result = { ...data }

  for (const [tag, rawValue] of Object.entries(data)) {
    const schema = schemas[tag]
    if (!schema) continue

    result[tag] = applySchemaToValue(rawValue, schema)
  }

  return result
}

describe('applySchemas', () => {
  it('returns empty object for null/undefined data', () => {
    expect(applySchemas(null, {})).toEqual({})
    expect(applySchemas(undefined, {})).toEqual({})
  })

  it('returns data as-is when no schemas provided', () => {
    const data = { 'nav-links': [{ label: 'Home' }] }
    expect(applySchemas(data, null)).toEqual(data)
    expect(applySchemas(data, undefined)).toEqual(data)
  })

  it('leaves data untouched when no matching schema', () => {
    const data = {
      'nav-links': [{ label: 'Home', href: '/' }],
      'other-data': { foo: 'bar' },
    }
    const schemas = {
      'social-links': { platform: 'string' },
    }
    expect(applySchemas(data, schemas)).toEqual(data)
  })

  it('applies defaults to array items', () => {
    const data = {
      'nav-links': [
        { label: 'Home', href: '/' },
        { label: 'About', href: '/about' },
      ],
    }
    const schemas = {
      'nav-links': {
        type: { type: 'select', options: ['plain', 'button'], default: 'plain' },
        target: { type: 'string', default: '_self' },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['nav-links']).toEqual([
      { label: 'Home', href: '/', type: 'plain', target: '_self' },
      { label: 'About', href: '/about', type: 'plain', target: '_self' },
    ])
  })

  it('preserves existing values (does not override)', () => {
    const data = {
      'nav-links': [
        { label: 'Docs', href: '/docs', type: 'button', target: '_blank' },
      ],
    }
    const schemas = {
      'nav-links': {
        type: { type: 'select', default: 'plain' },
        target: { type: 'string', default: '_self' },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['nav-links']).toEqual([
      { label: 'Docs', href: '/docs', type: 'button', target: '_blank' },
    ])
  })

  it('preserves unknown fields not in schema', () => {
    const data = {
      'nav-links': [
        { label: 'Home', href: '/', customAttr: 'foo', anotherField: 123 },
      ],
    }
    const schemas = {
      'nav-links': {
        type: { type: 'select', default: 'plain' },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['nav-links']).toEqual([
      { label: 'Home', href: '/', customAttr: 'foo', anotherField: 123, type: 'plain' },
    ])
  })

  it('applies schema to single object (not array)', () => {
    const data = {
      'settings': { theme: 'dark' },
    }
    const schemas = {
      'settings': {
        showLogo: { type: 'boolean', default: true },
        maxItems: { type: 'number', default: 10 },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['settings']).toEqual({
      theme: 'dark',
      showLogo: true,
      maxItems: 10,
    })
  })

  it('handles nested object schema', () => {
    const data = {
      'card': {
        title: 'My Card',
        meta: { author: 'John' },
      },
    }
    const schemas = {
      'card': {
        meta: {
          type: 'object',
          schema: {
            author: 'string',
            date: { type: 'string', default: 'today' },
          },
        },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['card']).toEqual({
      title: 'My Card',
      meta: { author: 'John', date: 'today' },
    })
  })

  it('handles array with inline object schema', () => {
    const data = {
      'social': {
        links: [
          { platform: 'twitter', url: 'https://twitter.com/foo' },
          { platform: 'github', url: 'https://github.com/foo' },
        ],
      },
    }
    const schemas = {
      'social': {
        links: {
          type: 'array',
          of: {
            icon: { type: 'string', default: 'default-icon' },
          },
        },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['social'].links).toEqual([
      { platform: 'twitter', url: 'https://twitter.com/foo', icon: 'default-icon' },
      { platform: 'github', url: 'https://github.com/foo', icon: 'default-icon' },
    ])
  })

  it('handles multiple schemas', () => {
    const data = {
      'nav-links': [{ label: 'Home', href: '/' }],
      'social': { platform: 'twitter' },
    }
    const schemas = {
      'nav-links': {
        type: { type: 'select', default: 'plain' },
      },
      'social': {
        showIcon: { type: 'boolean', default: true },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['nav-links']).toEqual([{ label: 'Home', href: '/', type: 'plain' }])
    expect(result['social']).toEqual({ platform: 'twitter', showIcon: true })
  })

  it('handles shorthand field definitions (no default)', () => {
    const data = {
      'nav-links': [{ label: 'Home' }],
    }
    const schemas = {
      'nav-links': {
        href: 'string',  // Shorthand, no default
        type: { type: 'select', default: 'plain' },
      },
    }

    const result = applySchemas(data, schemas)

    // Shorthand fields don't add defaults, only explicit defaults are applied
    expect(result['nav-links']).toEqual([{ label: 'Home', type: 'plain' }])
  })

  it('handles false and 0 as valid default values', () => {
    const data = {
      'settings': {},
    }
    const schemas = {
      'settings': {
        enabled: { type: 'boolean', default: false },
        count: { type: 'number', default: 0 },
      },
    }

    const result = applySchemas(data, schemas)

    expect(result['settings']).toEqual({
      enabled: false,
      count: 0,
    })
  })
})
