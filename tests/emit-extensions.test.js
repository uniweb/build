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

  /** A foundation package (an extension is one), as the CLI scaffolds it. */
  const extensionPackage = (dir) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', main: './_entry.generated.js' }))
    return dir
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uw-ext-emit-'))
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    siteDir = join(root, 'site')
    mkdirSync(siteDir, { recursive: true })
    // A built extension in the standard `extensions/<name>/` workspace layout.
    const dist = join(extensionPackage(join(root, 'extensions', 'effects')), 'dist')
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
    const pkg = extensionPackage(join(root, 'fx'))
    const alt = join(pkg, 'dist')
    mkdirSync(alt, { recursive: true })
    writeFileSync(join(alt, 'entry.js'), 'x')
    expect(resolveExtensionDist('/fx/entry.js', root)).toEqual({
      distDir: alt,
      urlBase: 'fx',
      rest: 'entry.js',
      packageDir: pkg,
      built: true
    })
  })

  /**
   * ⛔ Until 2026-10-13 the lookup stopped at the folder the site is in, so a
   * site at `sites/main` never found the shared `extensions/effects` at the
   * workspace root — the layout the docs recommend for extensions shared by
   * several sites. The rule: `./workspace-extension.js`.
   */
  it('emits a shared extension for a site in sites/ — the segregated layout', () => {
    const nested = join(root, 'sites', 'main')
    mkdirSync(nested, { recursive: true })
    expect(names(collectExtensionAssets(['/effects/entry.js'], nested))).toEqual([
      'effects/assets/style.css',
      'effects/entry.js'
    ])
  })

  /**
   * The payload's URLs carry the deployment base (`site/extension-urls.js`), and
   * `dist/` does not. ⛔ Until 2026-10-13 the base was left on, so
   * `/docs/effects/entry.js` named an extension `docs` and a site deployed under
   * a subpath emitted none — and 404'd on its extension at runtime.
   */
  it('removes the deployment base before the URL names a folder', () => {
    const r = collectExtensionAssets(['/docs/effects/entry.js'], siteDir, { base: '/docs/' })
    expect(names(r)).toEqual(['effects/assets/style.css', 'effects/entry.js'])
    expect(r.unresolved).toEqual([])

    // CONTROL: the same URL with no base given names `docs`, which nothing builds.
    expect(collectExtensionAssets(['/docs/effects/entry.js'], siteDir).unresolved).toEqual(['/docs/effects/entry.js'])
  })

  it('reports an extension that exists and is not built apart from one that does not exist', () => {
    const fx = extensionPackage(join(root, 'fx'))
    const r = collectExtensionAssets(['/fx/entry.js', '/missing/entry.js'], siteDir)
    expect(r.emit).toEqual([])
    expect(r.unbuilt).toEqual([{ url: '/fx/entry.js', dir: fx }])
    expect(r.unresolved).toEqual(['/missing/entry.js'])
  })

  it('never emits a same-named folder that is not an extension — a built site has a dist/ too', () => {
    const sameName = join(root, 'sites', 'effects')
    mkdirSync(join(sameName, 'dist'), { recursive: true })
    writeFileSync(join(sameName, 'site.yml'), 'name: s\n')
    writeFileSync(join(sameName, 'dist', 'index.html'), '<!doctype html>')
    const nested = join(root, 'sites', 'main')
    mkdirSync(nested, { recursive: true })
    const emitted = names(collectExtensionAssets(['/effects/entry.js'], nested))
    expect(emitted).toContain('effects/entry.js')
    expect(emitted).not.toContain('effects/index.html')
  })

  it('classifies declaration shapes', () => {
    expect(isSiteRelative('/fx/entry.js')).toBe(true)
    expect(isSiteRelative('//cdn/fx.js')).toBe(false) // protocol-relative is absolute
    expect(isSiteRelative('https://cdn/fx.js')).toBe(false)
    expect(isSiteRelative('@acme/fx@1.0.0')).toBe(false)
  })
})
