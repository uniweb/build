/**
 * A static build's favicon (`src/site/favicon.js`): `site.yml`'s `favicon:`, else the first of
 * favicon.svg, favicon.ico and favicon.png in public/. `uniweb doctor` reads the same list
 * (`findPublicFavicon`), so the two cannot disagree about which file a site has.
 *
 * Either is a file of the site's own, linked under the deployment base like every other one. Until
 * 2026-10-27 a NAMED favicon was linked as written, so a GitHub Pages project site that named its
 * favicon linked `/favicon.svg` rather than `/repo/favicon.svg`.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPublicFavicon, faviconHref, touchIconHref } from '../src/site/favicon.js'

const DIRS = []
afterEach(() => {
  while (DIRS.length) rmSync(DIRS.pop(), { recursive: true, force: true })
})

function publicDir(...files) {
  const dir = mkdtempSync(join(tmpdir(), 'favicon-'))
  DIRS.push(dir)
  for (const f of files) writeFileSync(join(dir, f), '')
  return dir
}

describe('findPublicFavicon', () => {
  it('finds the first of favicon.svg, favicon.ico and favicon.png', () => {
    expect(findPublicFavicon(publicDir('favicon.png', 'favicon.ico'))).toBe('favicon.ico')
    expect(findPublicFavicon(publicDir('favicon.png', 'favicon.svg'))).toBe('favicon.svg')
    expect(findPublicFavicon(publicDir('favicon.png'))).toBe('favicon.png')
  })

  it('finds none in a folder without one, and in no folder', () => {
    expect(findPublicFavicon(publicDir('icon.svg'))).toBeNull()
    expect(findPublicFavicon(null)).toBeNull()
  })
})

describe('faviconHref', () => {
  it('links the named favicon, else the one public/ holds, else none', () => {
    const dir = publicDir('favicon.svg')
    expect(faviconHref('/brand/icon.png', dir, '/')).toBe('/brand/icon.png')
    expect(faviconHref(undefined, dir, '/')).toBe('/favicon.svg')
    expect(faviconHref('  ', dir, '/')).toBe('/favicon.svg')
    expect(faviconHref(undefined, publicDir(), '/')).toBeNull()
  })

  it('⭐ links a named site path under the base, as it does a found one', () => {
    const dir = publicDir('favicon.svg')
    expect(faviconHref('/favicon.ico', dir, '/repo/')).toBe('/repo/favicon.ico')
    expect(faviconHref(undefined, dir, '/repo/')).toBe('/repo/favicon.svg')
    expect(faviconHref('/favicon.ico', dir, '/repo')).toBe('/repo/favicon.ico')
  })

  it('links an address of its own as written', () => {
    expect(faviconHref('https://cdn.example/f.ico', null, '/repo/')).toBe('https://cdn.example/f.ico')
    expect(faviconHref('//cdn.example/f.ico', null, '/repo/')).toBe('//cdn.example/f.ico')
  })
})

describe('touchIconHref', () => {
  it('links the named touch icon under the base, and an address of its own as written', () => {
    expect(touchIconHref('/touch-icon.png', '/')).toBe('/touch-icon.png')
    expect(touchIconHref('/touch-icon.png', '/repo/')).toBe('/repo/touch-icon.png')
    expect(touchIconHref('https://cdn.example/t.png', '/repo/')).toBe('https://cdn.example/t.png')
  })

  it('links none it was not named — the build looks for no file of its own', () => {
    expect(touchIconHref(undefined, '/')).toBeNull()
    expect(touchIconHref('  ', '/')).toBeNull()
  })
})
