// normalizeHideIn — the shared page nav-visibility normalizer used by the
// content-collector (runtime page data) and the sync producer (the `hide_in` field).

import { describe, it, expect } from 'vitest'
import { normalizeHideIn } from '../src/site/nav-visibility.js'

describe('normalizeHideIn', () => {
  it('passes through an array of area names', () => {
    expect(normalizeHideIn({ hideIn: ['header', 'footer'] })).toEqual(['header', 'footer'])
  })

  it('accepts a single string for convenience', () => {
    expect(normalizeHideIn({ hideIn: 'footer' })).toEqual(['footer'])
  })

  it('folds the legacy hideInHeader/hideInFooter booleans', () => {
    expect(normalizeHideIn({ hideInHeader: true, hideInFooter: true })).toEqual(['header', 'footer'])
  })

  it('merges the array with the legacy booleans and dedupes', () => {
    expect(normalizeHideIn({ hideIn: ['header', 'sidebar'], hideInHeader: true })).toEqual(['header', 'sidebar'])
  })

  it('filters non-string entries and returns [] for empty/absent', () => {
    expect(normalizeHideIn({})).toEqual([])
    expect(normalizeHideIn({ hideIn: [null, 'header', 0, 'footer'] })).toEqual(['header', 'footer'])
  })
})
