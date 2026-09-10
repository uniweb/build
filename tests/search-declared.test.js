/**
 * `search: false` must stop the build emitting a search index.
 *
 * ⛔ THE BUG THIS PINS, and it shipped for as long as the predicate lived in
 * `@uniweb/projections`: the test was `config?.search?.enabled !== false`, and
 * optional chaining short-circuits on `null`/`undefined` ONLY. So a boolean
 * `search: false` evaluated `false.enabled` to `undefined`, `undefined !== false`
 * is `true`, and an author writing the natural spelling of "off" got no search
 * box **and** a published `search-index.json` carrying every page's text. On a
 * static export that artifact is world-readable.
 *
 * ⚠️ `@uniweb/core` fixed the identical expression in `Website.isSearchEnabled`
 * (documented there at length) while this copy did not — one predicate, two
 * implementations, and only one of them got the fix. That is why the gate now
 * has a single home and a test.
 *
 * ⚖️ Author tier only. A host's `services` block decides where queries are
 * ANSWERED at render; it says nothing about whether this build emits a file.
 */

import { describe, test, expect } from 'vitest'
import { searchDeclaredOn } from '../src/site/search-declared.js'

const site = (search) => ({ config: search === undefined ? {} : { search } })

describe('searchDeclaredOn — the author tier only', () => {
  test('⛔ the boolean OFF form, which the old predicate read as ON', () => {
    expect(searchDeclaredOn(site(false))).toBe(false)
  })

  test('the object OFF form', () => {
    expect(searchDeclaredOn(site({ enabled: false }))).toBe(false)
  })

  test('the boolean ON form', () => {
    expect(searchDeclaredOn(site(true))).toBe(true)
  })

  test('absent means on — search is the one service enabled by default', () => {
    expect(searchDeclaredOn(site(undefined))).toBe(true)
    expect(searchDeclaredOn({})).toBe(true)
    expect(searchDeclaredOn(undefined)).toBe(true)
  })

  test('options without `enabled` leave it on', () => {
    expect(searchDeclaredOn(site({ provider: 'endpoint', endpoint: '/_search' }))).toBe(true)
  })

  test('⭐ a host declining search does NOT stop the build emitting an index', () => {
    // The two questions are different: this one is "did the author ask for
    // search", the render-time one is "can this site be searched". A services
    // block belongs to the second and must not reach here — otherwise a static
    // build that happens to carry one would stop emitting the very file it
    // needs.
    const withHostDecline = { config: { search: true, services: { tracking: '/_e' } } }
    expect(searchDeclaredOn(withHostDecline)).toBe(true)
  })
})
