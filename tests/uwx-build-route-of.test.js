/**
 * buildRouteOf — the route the build gives a pushed or pulled page record.
 *
 * It must be the route the build reads back from the folder a pull writes for the record
 * (`pageDirName`): a parametric page is routed by its PARAM. A page pushed from files has one
 * word for its slug and its param; a page made in an app may have two (`slug: detail`,
 * `param_name: id`). ⛔ Until 2026-09-30 the route used the slug, so that page was addressed
 * `/articles/:detail` while its folder, `[id]`, built `/articles/:id`.
 */

import { buildRouteOf } from '../src/uwx/site.js'
import { pageDirName } from '../src/uwx/site-project.js'

const route = (record, parent = '/') => buildRouteOf(record, parent, 'en')

// The route the build reads from a folder name: `[x]` → `:x`, `[...path]` → `:path*`.
const segmentOfDir = (dir) => (dir === '[...path]' ? ':path*' : dir.replace(/^\[(.+)\]$/, ':$1'))

describe('buildRouteOf', () => {
  it('a page, an index page and a localized slug', () => {
    expect(route({ slug: 'about' })).toBe('/about')
    expect(route({ slug: 'intro' }, '/docs')).toBe('/docs/intro')
    expect(route({ slug: 'index', is_index: true }, '/docs')).toBe('/docs')
    expect(route({ slug: { en: 'blog', fr: 'blogue' } })).toBe('/blog')
  })

  it('a parametric page is routed by its param', () => {
    expect(route({ slug: 'slug', is_dynamic: true, param_name: 'slug' }, '/blog')).toBe('/blog/:slug')
    expect(route({ slug: 'detail', is_dynamic: true, param_name: 'id' }, '/articles')).toBe('/articles/:id')
    expect(route({ slug: 'slug', is_dynamic: true }, '/blog')).toBe('/blog/:slug')
  })

  it('the catch-all marker is `:path*`, whatever its param', () => {
    expect(route({ slug: '...path', is_dynamic: true, param_name: 'slug' }, '/wiki')).toBe('/wiki/:path*')
  })

  it('agrees with the folder the pull writes for the record', () => {
    const records = [
      { slug: 'slug', is_dynamic: true, param_name: 'slug' },
      { slug: 'detail', is_dynamic: true, param_name: 'id' },
      { slug: '...path', is_dynamic: true, param_name: 'slug' },
      { slug: 'uuid', is_dynamic: true },
    ]
    for (const record of records) {
      expect(route(record, '/x'), JSON.stringify(record)).toBe(`/x/${segmentOfDir(pageDirName(record, 'en'))}`)
    }
  })
})
