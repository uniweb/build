import { shouldPrefetchInDev } from '../src/site/plugin.js'
import { parseFetchConfig } from '../src/site/data-fetcher.js'
// Derived, never re-spelled — the convention is pinned once, in
// `@uniweb/core`'s tests/data-paths.test.js.
import { queryDataUrl, resolveFetchConfigs } from '@uniweb/core'

/** An external query's binding, resolved the way dev resolves it before asking. */
const external = (binding = {}) =>
  resolveFetchConfigs([parseFetchConfig({ query: 'things', ...binding })], {
    queries: { things: { url: 'https://api.example.com/things' } },
  }).get('things')

// In dev there is no prerender, so we embed a fetch into the boot payload only
// when the browser cannot fetch it live itself. Local file collections and
// `prerender: false` sources are left for the runtime to fetch (fresh on
// reload); remote build-time endpoints stay embedded.
describe('shouldPrefetchInDev', () => {
  it('does not embed a local file-based collection (runtime fetches /data/*.json live)', () => {
    // { query: 'books' } → { path: '/data/books.json', prerender: true, ... }
    const cfg = parseFetchConfig({ query: 'books' })
    expect(cfg.path).toBe(queryDataUrl('books'))
    expect(cfg.url).toBeUndefined()
    expect(shouldPrefetchInDev(cfg)).toBe(false)
  })

  it('does not embed a local file-based collection even with prerender:true', () => {
    expect(shouldPrefetchInDev(parseFetchConfig({ query: 'team', prerender: true }))).toBe(false)
  })

  it('embeds an external query whose binding asks for a build-time fetch (prerender:true)', () => {
    expect(shouldPrefetchInDev(external({ prerender: true }))).toBe(true)
  })

  it('does not embed an external query left to the browser — its default', () => {
    const cfg = external()
    expect(cfg.prerender).toBe(false)
    expect(shouldPrefetchInDev(cfg)).toBe(false)
  })

  it('does not embed a local collection explicitly set to prerender:false', () => {
    const cfg = parseFetchConfig({ query: 'books', prerender: false })
    expect(shouldPrefetchInDev(cfg)).toBe(false)
  })

  it('does not embed empty/invalid configs', () => {
    expect(shouldPrefetchInDev(null)).toBe(false)
    expect(shouldPrefetchInDev(undefined)).toBe(false)
    expect(shouldPrefetchInDev({})).toBe(false)
  })
})
