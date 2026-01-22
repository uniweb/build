import {
  extractRuntimeSchema,
  extractAllRuntimeSchemas,
  extractFoundationRuntime,
} from '../src/runtime-schema.js'

describe('extractRuntimeSchema', () => {
  it('returns null for empty/invalid input', () => {
    expect(extractRuntimeSchema(null)).toBeNull()
    expect(extractRuntimeSchema(undefined)).toBeNull()
    expect(extractRuntimeSchema('not an object')).toBeNull()
  })

  it('returns null when meta has no runtime-relevant properties', () => {
    const meta = {
      title: 'Hero',
      description: 'A hero component',
      category: 'impact',
    }
    expect(extractRuntimeSchema(meta)).toBeNull()
  })

  describe('background extraction', () => {
    it('extracts background: true', () => {
      const meta = { background: true }
      expect(extractRuntimeSchema(meta)).toEqual({ background: true })
    })

    it('extracts background: "auto"', () => {
      const meta = { background: 'auto' }
      expect(extractRuntimeSchema(meta)).toEqual({ background: 'auto' })
    })

    it('extracts background: "manual"', () => {
      const meta = { background: 'manual' }
      expect(extractRuntimeSchema(meta)).toEqual({ background: 'manual' })
    })

    it('ignores background: false', () => {
      const meta = { background: false }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })
  })

  describe('data parsing', () => {
    it('parses type only', () => {
      const meta = { data: 'events' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: null },
      })
    })

    it('parses type with limit', () => {
      const meta = { data: 'events:6' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
      })
    })

    it('trims whitespace', () => {
      const meta = { data: ' articles : 5 ' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'articles', limit: 5 },
      })
    })

    it('handles single entity', () => {
      const meta = { data: 'project:1' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'project', limit: 1 },
      })
    })

    it('ignores invalid data values', () => {
      expect(extractRuntimeSchema({ data: null })).toBeNull()
      expect(extractRuntimeSchema({ data: 123 })).toBeNull()
      expect(extractRuntimeSchema({ data: '' })).toBeNull()
    })
  })

  describe('param defaults extraction', () => {
    it('extracts defaults from params', () => {
      const meta = {
        params: {
          theme: { type: 'select', default: 'gradient' },
          layout: { type: 'select', default: 'center' },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'gradient', layout: 'center' },
      })
    })

    it('handles boolean defaults', () => {
      const meta = {
        params: {
          showPattern: { type: 'boolean', default: true },
          showBorder: { type: 'boolean', default: false },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { showPattern: true, showBorder: false },
      })
    })

    it('handles numeric defaults', () => {
      const meta = {
        params: {
          maxItems: { type: 'number', default: 6 },
          columns: { type: 'number', default: 0 },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { maxItems: 6, columns: 0 },
      })
    })

    it('ignores params without defaults', () => {
      const meta = {
        params: {
          theme: { type: 'select', default: 'gradient' },
          customClass: { type: 'string' }, // no default
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'gradient' },
      })
    })

    it('returns null when no params have defaults', () => {
      const meta = {
        params: {
          customClass: { type: 'string' },
        },
      }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })

    it('ignores invalid params values', () => {
      expect(extractRuntimeSchema({ params: null })).toBeNull()
      expect(extractRuntimeSchema({ params: 'invalid' })).toBeNull()
    })

    it('supports v1 "properties" field name', () => {
      const meta = {
        properties: {
          theme: { type: 'select', default: 'gradient' },
          layout: { type: 'select', default: 'center' },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'gradient', layout: 'center' },
      })
    })

    it('prefers v2 "params" over v1 "properties"', () => {
      const meta = {
        params: { theme: { default: 'v2-value' } },
        properties: { theme: { default: 'v1-value' } },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'v2-value' },
      })
    })
  })

  describe('combined extraction', () => {
    it('extracts all runtime properties', () => {
      const meta = {
        title: 'Event Grid',
        description: 'Display events in a grid',
        category: 'showcase',
        background: true,
        data: 'events:6',
        params: {
          layout: { type: 'select', default: 'grid' },
          columns: { type: 'number', default: 3 },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        background: true,
        data: { type: 'events', limit: 6 },
        defaults: { layout: 'grid', columns: 3 },
      })
    })
  })
})

describe('extractAllRuntimeSchemas', () => {
  it('extracts schemas for multiple components', () => {
    const componentsMeta = {
      Hero: {
        title: 'Hero',
        background: true,
        params: { theme: { default: 'gradient' } },
      },
      Features: {
        title: 'Features',
        data: 'features:6',
      },
      Text: {
        title: 'Text Section',
        category: 'structure',
      },
    }

    const result = extractAllRuntimeSchemas(componentsMeta)

    expect(result).toEqual({
      Hero: {
        background: true,
        defaults: { theme: 'gradient' },
      },
      Features: {
        data: { type: 'features', limit: 6 },
      },
      // Text is excluded (no runtime properties)
    })
  })

  it('returns empty object when no components have runtime properties', () => {
    const componentsMeta = {
      Text: { title: 'Text', category: 'structure' },
      Section: { title: 'Section', category: 'structure' },
    }
    expect(extractAllRuntimeSchemas(componentsMeta)).toEqual({})
  })

  it('handles empty input', () => {
    expect(extractAllRuntimeSchemas({})).toEqual({})
  })
})

describe('extractFoundationRuntime', () => {
  it('returns empty object for invalid input', () => {
    expect(extractFoundationRuntime(null)).toEqual({})
    expect(extractFoundationRuntime(undefined)).toEqual({})
    expect(extractFoundationRuntime('not an object')).toEqual({})
  })

  it('extracts name and title', () => {
    const meta = {
      name: 'marketing',
      title: 'Marketing Foundation',
      description: 'Components for marketing sites',
    }
    expect(extractFoundationRuntime(meta)).toEqual({
      name: 'marketing',
      title: 'Marketing Foundation',
    })
  })

  it('extracts runtime props from "runtime" field', () => {
    const meta = {
      name: 'marketing',
      runtime: {
        themeToggle: true,
        analyticsEnabled: false,
      },
    }
    expect(extractFoundationRuntime(meta)).toEqual({
      name: 'marketing',
      runtime: {
        themeToggle: true,
        analyticsEnabled: false,
      },
    })
  })

  it('extracts runtime props from legacy "props" field', () => {
    const meta = {
      name: 'legacy',
      props: {
        themeToggle: true,
      },
    }
    expect(extractFoundationRuntime(meta)).toEqual({
      name: 'legacy',
      runtime: {
        themeToggle: true,
      },
    })
  })

  it('prefers "runtime" over "props" when both exist', () => {
    const meta = {
      name: 'test',
      runtime: { newField: true },
      props: { oldField: true },
    }
    expect(extractFoundationRuntime(meta)).toEqual({
      name: 'test',
      runtime: { newField: true },
    })
  })

  it('returns empty object when no relevant fields', () => {
    const meta = {
      description: 'Just a description',
      styles: { primary: { type: 'color' } },
    }
    expect(extractFoundationRuntime(meta)).toEqual({})
  })
})
