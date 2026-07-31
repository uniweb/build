/**
 * `values:` — an open map in the data-schema vocabulary.
 *
 * `fields` describes an object's KNOWN keys. `values` describes a map whose keys
 * belong to the author and whose values all conform to one shape — what `items`
 * is to an array. Until this existed the vocabulary could not describe a
 * map-of-X at all, which is the shape `@std/form` needs: a form's `fields` is
 * keyed by author-chosen field names.
 *
 * Requested by the editor team (channel frontend-framework-066d, 2026-07-31)
 * after both sides independently found they could not state the shape.
 */

import { describe, expect, it } from 'vitest'
import { validateItem } from '../src/validate-data.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

const fieldSpec = {
  type: 'object',
  fields: { type: { type: 'string', required: true }, label: { type: 'string' } },
}
const mapSchema = { fields: { m: { type: 'object', values: fieldSpec } } }

describe('values: validates every entry of an open map', () => {
  it('accepts a map whose values all conform', () => {
    expect(validateItem(mapSchema, { m: { a: { type: 'string', label: 'A' }, b: { type: 'file' } } })).toEqual([])
  })

  it('names the offending key in the path', () => {
    // The key is the author's, so a finding has to say WHICH entry — otherwise
    // "expected string" on a twenty-field form is unactionable.
    const found = validateItem(mapSchema, { m: { a: { type: 'string' }, b: { type: 42 } } })
    expect(found.map((f) => f.field)).toEqual(['m.b.type'])
  })

  it('enforces required inside a value', () => {
    const found = validateItem(mapSchema, { m: { a: { label: 'no type' } } })
    expect(found.map((f) => `${f.field}:${f.rule}`)).toEqual(['m.a.type:required'])
  })

  it('still rejects a non-object where a map is declared', () => {
    expect(validateItem(mapSchema, { m: [1, 2] }).map((f) => f.rule)).toEqual(['type'])
  })

  it('tolerates keys the value schema does not declare', () => {
    // Load-bearing, not laxity. A form definition may carry per-field keys the
    // current builder cannot author — hand-written, or from a newer editor —
    // and the editor's boundary passes them through untouched. Rejecting them
    // would fail builds on good content.
    expect(validateItem(mapSchema, { m: { a: { type: 'string', placeholder: 'hi', future: 1 } } })).toEqual([])
  })

  it('accepts an empty map', () => {
    expect(validateItem(mapSchema, { m: {} })).toEqual([])
  })
})

describe('values: normalization', () => {
  const normalize = (fields) => validateAndNormalizeSchema({ name: 't', fields }, '@t/t')

  it('normalizes the value shape like any other field', () => {
    const out = normalize({ m: { type: 'object', values: { type: 'string' } } })
    expect(out.fields.m.values.type).toBe('string')
  })

  it('refuses fields and values together', () => {
    // They answer different questions; declaring both is a confused schema
    // rather than a merge, and guessing which wins would be worse.
    expect(() => normalize({ m: { type: 'object', fields: { a: { type: 'string' } }, values: { type: 'string' } } }))
      .toThrow(/both 'fields' and 'values'/)
  })

  it('still requires an object to declare one of them', () => {
    expect(() => normalize({ m: { type: 'object' } })).toThrow(/'fields'.*or 'values'/)
  })
})
