import { describe, it, expect } from 'vitest'
import {
  resolveModuleUrl,
  resolveExtensionUrls,
  stripBasePath,
} from '../src/site/extension-urls.js'

/**
 * The producer owns deployment-base resolution for module URLs.
 *
 * What reaches the runtime is FINAL: the loader anchors a root-relative URL to
 * the document origin and applies no base of its own. So the base is applied
 * here, once, and the same helper feeds all three consumers — the payload's
 * `config.extensions`, the `__FOUNDATION_CONFIG__` define, and the
 * `<link rel=modulepreload>` hints. Before this, the runtime base-resolved
 * extensions (but not the primary foundation) at load time while the preload
 * hint emitted the raw URL, so on a subdirectory deploy the browser preloaded
 * one URL and then requested another.
 */
describe('resolveModuleUrl', () => {
  it('prefixes a root-relative string', () => {
    expect(resolveModuleUrl('/effects/entry.js', '/docs/')).toBe('/docs/effects/entry.js')
  })

  it('resolves BOTH url and cssUrl on an object', () => {
    // The old runtime helper rewrote `url` only, so an explicit root-relative
    // cssUrl under a subdirectory deploy missed the base and 404'd — silently,
    // because the runtime tolerates a failed stylesheet by design. The only
    // symptom was an unstyled foundation.
    expect(
      resolveModuleUrl({ url: '/e/entry.js', cssUrl: '/e/assets/style.css' }, '/docs/')
    ).toEqual({ url: '/docs/e/entry.js', cssUrl: '/docs/e/assets/style.css' })
  })

  it('preserves sibling fields on an object', () => {
    expect(resolveModuleUrl({ mode: 'runtime', url: '/e/entry.js' }, '/docs/'))
      .toEqual({ mode: 'runtime', url: '/docs/e/entry.js' })
  })

  it('passes absolute URLs through untouched', () => {
    const abs = 'https://cdn.example.com/foundations/x/1.0.0/entry.js'
    expect(resolveModuleUrl(abs, '/docs/')).toBe(abs)
    expect(resolveModuleUrl({ url: abs, cssUrl: abs }, '/docs/')).toEqual({ url: abs, cssUrl: abs })
  })

  it('passes PROTOCOL-relative URLs through untouched', () => {
    // `//host/path` is absolute. The old runtime helper tested only
    // `startsWith('/')`, so it would have mangled this into `/docs//host/path`.
    expect(resolveModuleUrl('//cdn.example.com/entry.js', '/docs/'))
      .toBe('//cdn.example.com/entry.js')
  })

  it('passes registry refs through untouched', () => {
    // `config.extensions` can carry a `@org/name@version` ref, which is not a
    // URL at all and must never be prefixed.
    expect(resolveModuleUrl('@acme/gallery@2.1.0', '/docs/')).toBe('@acme/gallery@2.1.0')
  })

  it('passes relative paths through untouched', () => {
    expect(resolveModuleUrl('./entry.js', '/docs/')).toBe('./entry.js')
  })

  it('is the identity when there is no real base', () => {
    for (const base of ['/', '', undefined, null]) {
      expect(resolveModuleUrl('/effects/entry.js', base)).toBe('/effects/entry.js')
    }
  })

  it('tolerates a base with no trailing slash', () => {
    expect(resolveModuleUrl('/effects/entry.js', '/docs')).toBe('/docs/effects/entry.js')
  })

  it('returns the SAME object reference when nothing needs resolving', () => {
    // So a payload built without a base is byte-identical to before.
    const source = { url: 'https://cdn.example.com/e.js' }
    expect(resolveModuleUrl(source, '/docs/')).toBe(source)
  })
})

describe('resolveExtensionUrls', () => {
  it('maps every entry and preserves order', () => {
    expect(resolveExtensionUrls(['/a/entry.js', '/b/entry.js'], '/docs/'))
      .toEqual(['/docs/a/entry.js', '/docs/b/entry.js'])
  })

  it('handles a mixed list — url, object, absolute, ref', () => {
    const out = resolveExtensionUrls(
      ['/a/entry.js', { url: '/b/entry.js' }, 'https://cdn/c.js', '@acme/d@1.0.0'],
      '/docs/'
    )
    expect(out).toEqual([
      '/docs/a/entry.js',
      { url: '/docs/b/entry.js' },
      'https://cdn/c.js',
      '@acme/d@1.0.0',
    ])
  })

  it('returns the input untouched when there is no base or no extensions', () => {
    const list = ['/a/entry.js']
    expect(resolveExtensionUrls(list, '/')).toBe(list)
    expect(resolveExtensionUrls(list, undefined)).toBe(list)
    expect(resolveExtensionUrls([], '/docs/')).toEqual([])
    expect(resolveExtensionUrls(undefined, '/docs/')).toBeUndefined()
  })
})

describe('stripBasePath', () => {
  it('removes the base so a served URL maps onto the build tree', () => {
    // `dist/` has no base segment: a site deployed at /docs/ still writes
    // dist/effects/entry.js. This is what keeps SSG prerender able to load an
    // extension after the payload started carrying final URLs.
    expect(stripBasePath('/docs/effects/entry.js', '/docs/')).toBe('/effects/entry.js')
  })

  it('leaves a URL that does not carry the base unchanged', () => {
    // Payloads produced before this change, and absolute URLs.
    expect(stripBasePath('/effects/entry.js', '/docs/')).toBe('/effects/entry.js')
    expect(stripBasePath('https://cdn/e.js', '/docs/')).toBe('https://cdn/e.js')
  })

  it('is the identity when there is no real base', () => {
    expect(stripBasePath('/effects/entry.js', '/')).toBe('/effects/entry.js')
    expect(stripBasePath('/effects/entry.js', undefined)).toBe('/effects/entry.js')
  })

  it('round-trips with resolveModuleUrl', () => {
    const url = '/effects/entry.js'
    expect(stripBasePath(resolveModuleUrl(url, '/docs/'), '/docs/')).toBe(url)
  })
})
