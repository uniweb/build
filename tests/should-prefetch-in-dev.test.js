import { shouldPrefetchInDev } from '../src/site/plugin.js'
import { parseFetchConfig } from '../src/site/data-fetcher.js'
// Derived, never re-spelled — the convention is pinned once, in
// `@uniweb/core`'s tests/data-paths.test.js.
import { collectionDataUrl } from '@uniweb/core'

// In dev there is no prerender, so we embed a fetch into the boot payload only
// when the browser cannot fetch it live itself. Local file collections and
// `prerender: false` sources are left for the runtime to fetch (fresh on
// reload); remote build-time endpoints stay embedded.
describe('shouldPrefetchInDev', () => {
  it('does not embed a local file-based collection (runtime fetches /data/*.json live)', () => {
    // { query: 'books' } → { path: '/data/books.json', prerender: true, ... }
    const cfg = parseFetchConfig({ query: 'books' })
    expect(cfg.path).toBe(collectionDataUrl('books'))
    expect(cfg.url).toBeUndefined()
    expect(shouldPrefetchInDev(cfg)).toBe(false)
  })

  it('does not embed a local path source even with prerender:true', () => {
    const cfg = parseFetchConfig('/data/team.json')
    expect(cfg.prerender).toBe(true)
    expect(shouldPrefetchInDev(cfg)).toBe(false)
  })

  it('embeds a remote url source with default (prerender:true) build-time fetch', () => {
    const cfg = parseFetchConfig({ url: 'https://api.example.com/things', prerender: true })
    expect(shouldPrefetchInDev(cfg)).toBe(true)
  })

  it('does not embed a remote url source opted into runtime fetch (prerender:false)', () => {
    // url sources default to prerender:false anyway
    const cfg = parseFetchConfig({ url: 'https://api.example.com/things' })
    expect(cfg.prerender).toBe(false)
    expect(shouldPrefetchInDev(cfg)).toBe(false)
  })

  it('does not embed a local collection explicitly set to prerender:false', () => {
    const cfg = parseFetchConfig({ query: 'books', prerender: false })
    expect(shouldPrefetchInDev(cfg)).toBe(false)
  })

  it('does not embed refinements or empty/invalid configs', () => {
    expect(shouldPrefetchInDev(parseFetchConfig({ refine: true, limit: 3 }))).toBe(false)
    expect(shouldPrefetchInDev(null)).toBe(false)
    expect(shouldPrefetchInDev(undefined)).toBe(false)
    expect(shouldPrefetchInDev({})).toBe(false)
  })
})
