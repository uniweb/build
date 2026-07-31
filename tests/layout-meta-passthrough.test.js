/**
 * Layout meta is a whitelist, and a whitelist drops what it does not name.
 *
 * `extractLayoutRuntimeSchema` copies a fixed set of keys out of a layout's
 * meta.js. Anything else is discarded silently — the build succeeds, the site
 * runs, and the declaration simply does nothing. That is the same failure the
 * misplaced-capabilities guard exists for, one level down.
 *
 * Two live cases, found on 2026-07-31 while designing area layers:
 *
 *   - `transitions: false` is the DOCUMENTED way a layout opts out of per-area
 *     view transitions, and `resolveLayoutTransitions` has always handled it —
 *     but the guard here was `fullMeta.transitions && typeof … === 'object'`,
 *     which is false for `false`. The opt-out never reached the runtime.
 *   - `layers` is new and would have been dropped the same way.
 */

import { describe, expect, it } from 'vitest'
import { extractLayoutRuntimeSchema } from '../src/runtime-schema.js'

describe('layout meta reaches the runtime', () => {
  it('carries transitions: false — a value, not an absence', () => {
    const out = extractLayoutRuntimeSchema({ areas: ['header'], transitions: false })
    expect(out.transitions).toBe(false)
  })

  it('still carries a per-region transitions object', () => {
    const out = extractLayoutRuntimeSchema({ areas: ['header'], transitions: { left: null } })
    expect(out.transitions).toEqual({ left: null })
  })

  it('carries a layers object', () => {
    const out = extractLayoutRuntimeSchema({ areas: ['header'], layers: { header: 5, footer: 0 } })
    expect(out.layers).toEqual({ header: 5, footer: 0 })
  })

  it('carries layers: false', () => {
    const out = extractLayoutRuntimeSchema({ areas: ['header'], layers: false })
    expect(out.layers).toBe(false)
  })

  it('omits both when the layout declares neither', () => {
    // Absent must stay absent, or every layout would ship keys it never wrote
    // and the runtime could not tell "unset" from "set to the default".
    const out = extractLayoutRuntimeSchema({ areas: ['header'] })
    expect(out).not.toHaveProperty('transitions')
    expect(out).not.toHaveProperty('layers')
  })

  it('ignores a malformed value rather than passing it through', () => {
    const out = extractLayoutRuntimeSchema({ areas: ['header'], layers: 'above', transitions: 7 })
    expect(out).not.toHaveProperty('layers')
    expect(out).not.toHaveProperty('transitions')
  })
})
