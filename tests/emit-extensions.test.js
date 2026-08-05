import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectExtensionAssets,
  isSiteRelative,
  resolveExtensionDist
} from '../src/site/emit-extensions.js'

/**
 * A site-relative extension (`/effects/entry.js`) is served from the site's OWN
 * origin, so the site's build has to put it there. Nothing did.
 *
 * The failure was silent and inverted: the build succeeded, prerender loaded the
 * extension from the workspace and rendered its sections into the static HTML,
 * then the browser 404'd on the URL, `loadExtensions()` dropped it, and
 * hydration REPLACED the correct markup with `Component not found`. A visitor
 * watched a working section break. Measured on the `extensions` template.
 */
describe('collectExtensionAssets', () => {
  let root, siteDir

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uw-ext-emit-'))
    siteDir = join(root, 'site')
    mkdirSync(siteDir, { recursive: true })
    // A built extension in the standard `extensions/<name>/` workspace layout.
    const dist = join(root, 'extensions', 'effects', 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    mkdirSync(join(dist, 'meta'), { recursive: true })
    writeFileSync(join(dist, 'entry.js'), 'export const A = 1\n')
    writeFileSync(join(dist, 'entry.js.map'), '{}')
    writeFileSync(join(dist, 'entry-ssr.js'), 'export const A = 1\n')
    writeFileSync(join(dist, 'runtime-pin.json'), '{"runtime":"0.9.7"}')
    writeFileSync(join(dist, 'assets', 'style.css'), 'a{}')
    writeFileSync(join(dist, 'meta', 'schema.json'), '{}')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const names = (r) => r.emit.map((e) => e.fileName).sort()

  it('emits the browser set at the declared URL path', () => {
    const r = collectExtensionAssets(['/effects/entry.js'], siteDir)
    expect(names(r)).toEqual(['effects/assets/style.css', 'effects/entry.js'])
    expect(r.unresolved).toEqual([])
  })

  it('withholds what a static host should not serve', () => {
    // Same browser/internal split the runtime channel draws: the SSR twin is for
    // an isolate, `meta/` is the editor schema, the pin is provenance, maps are
    // dev-only. None of them belong on a public origin.
    const emitted = names(collectExtensionAssets(['/effects/entry.js'], siteDir))
    for (const withheld of ['entry-ssr.js', 'runtime-pin.json', 'meta/schema.json', 'entry.js.map']) {
      expect(emitted.some((f) => f.endsWith(withheld))).toBe(false)
    }
  })

  it('ignores an absolute URL — someone else serves that one', () => {
    const r = collectExtensionAssets(['https://cdn.example.com/fx/entry.js'], siteDir)
    expect(r.emit).toEqual([])
    expect(r.unresolved).toEqual([])
  })

  it('ignores a catalog ref, which is not a URL at all', () => {
    expect(collectExtensionAssets(['@acme/fx@1.0.0'], siteDir).emit).toEqual([])
  })

  it('reports a site-relative URL with no build, rather than emitting nothing quietly', () => {
    // The developer can act on this; a silent skip reproduces the original bug.
    const r = collectExtensionAssets(['/missing/entry.js'], siteDir)
    expect(r.emit).toEqual([])
    expect(r.unresolved).toEqual(['/missing/entry.js'])
  })

  it('accepts the object form', () => {
    expect(names(collectExtensionAssets([{ url: '/effects/entry.js' }], siteDir)))
      .toContain('effects/entry.js')
  })

  it('resolves the bare project-root layout too', () => {
    const alt = join(root, 'fx', 'dist')
    mkdirSync(alt, { recursive: true })
    writeFileSync(join(alt, 'entry.js'), 'x')
    expect(resolveExtensionDist('/fx/entry.js', siteDir).distDir).toBe(alt)
  })

  it('classifies declaration shapes', () => {
    expect(isSiteRelative('/fx/entry.js')).toBe(true)
    expect(isSiteRelative('//cdn/fx.js')).toBe(false) // protocol-relative is absolute
    expect(isSiteRelative('https://cdn/fx.js')).toBe(false)
    expect(isSiteRelative('@acme/fx@1.0.0')).toBe(false)
  })
})
