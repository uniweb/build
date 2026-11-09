/**
 * `values:`, an open map, is refused (2026-11-09 [Diego]: "we should definitely retire it").
 *
 * It was added on 2026-07-31 for `@std/form`'s map of fields, which became a list of controls
 * five days later, and stayed with no use. A record holds no open map: keys the schema knows
 * are an object's `fields:`, and keys that are data make a list of records that each carry their
 * key. The refusal names both, so an author meets what to write instead of a bare "unknown key".
 */

import { describe, expect, it } from 'vitest'
import { validateItem } from '../src/validate-data.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

const normalize = (fields) => validateAndNormalizeSchema({ name: 't', fields }, '@t/t')

describe('values: is refused', () => {
  it('names the two forms keyed data takes', () => {
    const open = () => normalize({ license: { type: 'object', values: { type: 'number' } } })
    expect(open).toThrow(/field 'license' declares 'values', which a data schema does not take/)
    expect(open).toThrow(/`fields:` when the schema knows them/)
    expect(open).toThrow(/a list of records that each carry their key \(`many: true`/)
  })

  it('refuses it beside fields too, rather than reading one of them', () => {
    expect(() => normalize({ m: { type: 'object', fields: { a: { type: 'string' } }, values: { type: 'string' } } }))
      .toThrow(/declares 'values', which a data schema does not take/)
  })

  it('still requires an object to declare its fields', () => {
    expect(() => normalize({ m: { type: 'object' } })).toThrow(/object field 'm' must declare its 'fields'/)
  })
})

describe('the two forms', () => {
  it('known keys: a group checks each key as a field', () => {
    const schema = normalize({
      license: { type: 'object', fields: { small: { type: 'number' }, 'extra-large': { type: 'number' } } },
    })
    expect(validateItem(schema, { license: { small: 59, 'extra-large': 349 } })).toEqual([])
    expect(validateItem(schema, { license: { small: 'cheap' } }).map((f) => `${f.field}:${f.rule}`)).toEqual(['license.small:type'])
  })

  it('keys that are data: a list whose records carry their key', () => {
    const schema = normalize({
      measurements: {
        type: 'object',
        many: true,
        fields: { label: { type: 'string', required: true }, value: { type: 'number' }, unit: { type: 'string' } },
      },
    })
    expect(validateItem(schema, { measurements: [{ label: 'Diameter', value: 12, unit: 'cm' }] })).toEqual([])
    expect(validateItem(schema, { measurements: [{ value: 12 }] }).map((f) => `${f.field}:${f.rule}`)).toEqual([
      'measurements[0].label:required',
    ])
  })
})
