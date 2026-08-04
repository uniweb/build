/**
 * Extensions are declared like foundations.
 *
 * Ruling 2026-08-04: "extensions should be delivered like any other foundation —
 * the whole point is that they are regular foundations except for minor
 * differences." So `site.yml::extensions` accepts the same shapes `foundation:`
 * does, and the wire carries whichever the author wrote rather than a resolution.
 *
 * These tests pin the producer contract three lanes depend on: the wire shape
 * (backend projects it into the served payload), the round-trip (a pull must not
 * rewrite a ref into a URL or drop it), and the URL classification (the publish
 * guard and the CLI's bring-along both key off it, so it must be decided once).
 */

import { describe, test, expect } from 'vitest'
import {
  extensionDeclaration,
  isExtensionUrl,
  isSiteRelativeExtensionUrl
} from '../src/uwx/site.js'

describe('extension declaration → wire shape', () => {
  test('a catalog ref rides as `ref`, not `url`', () => {
    const d = extensionDeclaration('@acme/effects@1.2.3')
    expect(d).toEqual({
      $id: '@acme/effects@1.2.3',
      fields: { ref: '@acme/effects@1.2.3' }
    })
  })

  test('a bare local name rides as `ref` — publish pins it later', () => {
    // `effects` is a workspace package name; it cannot be resolved here (that is
    // detectFoundationType's job at build/publish time), so the wire carries the
    // declaration verbatim and `injectExtensions` stamps the pinned ref over it.
    expect(extensionDeclaration('effects')).toEqual({
      $id: 'effects',
      fields: { ref: 'effects' }
    })
  })

  test('an absolute URL rides as `url`', () => {
    const d = extensionDeclaration('https://cdn.example.com/effects/entry.js')
    expect(d.fields).toEqual({
      url: 'https://cdn.example.com/effects/entry.js'
    })
  })

  test('a site-relative URL still rides as `url` — the publish guard rejects it, not the projection', () => {
    // The wire must represent it faithfully: `export`/`deploy --host` are legal
    // homes for this form, so dropping it here would break those lanes.
    expect(extensionDeclaration('/effects/entry.js').fields).toEqual({
      url: '/effects/entry.js'
    })
  })

  test('object form: {url} and {ref}/{name}', () => {
    expect(extensionDeclaration({ url: 'https://x.test/e.js' }).fields).toEqual({
      url: 'https://x.test/e.js'
    })
    expect(extensionDeclaration({ ref: '@acme/e@1.0.0' }).fields).toEqual({
      ref: '@acme/e@1.0.0'
    })
    expect(extensionDeclaration({ name: 'effects' }).fields).toEqual({
      ref: 'effects'
    })
  })

  test('unusable entries are dropped rather than emitted empty', () => {
    expect(extensionDeclaration(null)).toBeNull()
    expect(extensionDeclaration('')).toBeNull()
    expect(extensionDeclaration(42)).toBeNull()
    expect(extensionDeclaration({})).toBeNull()
  })

  test('$id is the authored declaration — the key publish stamps a pin onto', () => {
    // injectExtensions is keyed by $id, so it must be what the author wrote and
    // must survive unchanged when the ref it resolves to moves.
    expect(extensionDeclaration('effects').$id).toBe('effects')
    expect(extensionDeclaration({ ref: '@a/b@1.0.0' }).$id).toBe('@a/b@1.0.0')
  })
})

describe('URL classification — one decision, three consumers', () => {
  test('URLs are absolute or site-relative; names are neither', () => {
    expect(isExtensionUrl('https://x.test/e.js')).toBe(true)
    expect(isExtensionUrl('http://x.test/e.js')).toBe(true)
    expect(isExtensionUrl('/effects/entry.js')).toBe(true)
    expect(isExtensionUrl('effects')).toBe(false)
    expect(isExtensionUrl('@acme/effects@1.0.0')).toBe(false)
  })

  test('only the site-relative form is rejected at publish', () => {
    expect(isSiteRelativeExtensionUrl('/effects/entry.js')).toBe(true)
    // An absolute URL is fine on every lane — it is the registry-hosted shape.
    expect(isSiteRelativeExtensionUrl('https://x.test/e.js')).toBe(false)
    expect(isSiteRelativeExtensionUrl('@acme/effects@1.0.0')).toBe(false)
  })

  test('a scoped ref is never mistaken for a URL', () => {
    // Regression guard: `@org/name@1.2.3` contains slashes and an @; a naive
    // "looks like a path" check would classify it as a URL and it would then be
    // handed to import() verbatim instead of being resolved.
    expect(isExtensionUrl('@org/name@1.2.3')).toBe(false)
    expect(extensionDeclaration('@org/name@1.2.3').fields.ref).toBe(
      '@org/name@1.2.3'
    )
  })
})
