import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extensionCandidates,
  extensionNameOf,
  extensionSearchDirs,
  findExtensionPackage,
  findSiteExtension
} from '../src/site/workspace-extension.js'

/**
 * Where a site finds a workspace extension — the one rule the build, prerender,
 * the dev server and the CLI all ask. The extension named `<name>` is the nearest
 * `<name>/` or `extensions/<name>/` that is a foundation package, from the folder
 * the site is in up to the workspace root.
 *
 * ⛔ Until 2026-10-13 the build looked in the site's folder only, while `add
 * extension` judged reachability from the workspace root: a site at `sites/main`
 * was wired to `extensions/effects` and its build then could not find it.
 */
describe('where a site finds a workspace extension', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uw-ws-ext-'))
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A foundation package (an extension is one), as the CLI scaffolds it. */
  const pkg = (rel) => {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', main: './_entry.generated.js' }))
    return dir
  }
  /** A site package. */
  const site = (rel) => {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'site.yml'), 'name: s\n')
    return dir
  }

  it('finds <name>/ beside the site', () => {
    const ext = pkg('effects')
    expect(findSiteExtension('effects', site('site'))).toBe(ext)
  })

  it('finds extensions/<name>/ beside the site', () => {
    const siteDir = site('site')
    expect(findSiteExtension('effects', siteDir)).toBeNull() // CONTROL: nothing there yet
    const ext = pkg('extensions/effects')
    expect(findSiteExtension('effects', siteDir)).toBe(ext)
  })

  it('finds a shared extension at the workspace root from a site in sites/ — the segregated layout', () => {
    const ext = pkg('extensions/effects')
    expect(findSiteExtension('effects', site('sites/main'))).toBe(ext)
  })

  it('finds a root-level extension from a co-located project site', () => {
    const ext = pkg('effects')
    expect(findSiteExtension('effects', site('docs/site'))).toBe(ext)
  })

  it('takes the nearest when two have the name', () => {
    pkg('effects')
    const near = pkg('docs/effects')
    expect(findSiteExtension('effects', site('docs/site'))).toBe(near)
  })

  it('passes over a folder of that name that is not a foundation — a built site has a dist/ too', () => {
    const sameName = site('sites/effects')
    mkdirSync(join(sameName, 'dist'), { recursive: true })
    const ext = pkg('extensions/effects')
    expect(findSiteExtension('effects', site('sites/main'))).toBe(ext)
  })

  it('stops at the workspace root', () => {
    // An extension one folder ABOVE the workspace is not part of it.
    const outer = mkdtempSync(join(tmpdir(), 'uw-ws-outer-'))
    try {
      const outside = join(outer, 'effects')
      mkdirSync(outside)
      writeFileSync(join(outside, 'package.json'), JSON.stringify({ main: './_entry.generated.js' }))
      const ws = join(outer, 'ws')
      mkdirSync(join(ws, 'site'), { recursive: true })
      writeFileSync(join(ws, 'pnpm-workspace.yaml'), 'packages: []\n')
      expect(findSiteExtension('effects', join(ws, 'site'))).toBeNull()

      // CONTROL: the same extension, inside the workspace.
      const inside = join(ws, 'effects')
      mkdirSync(inside)
      writeFileSync(join(inside, 'package.json'), JSON.stringify({ main: './_entry.generated.js' }))
      expect(findSiteExtension('effects', join(ws, 'site'))).toBe(inside)
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })

  it('recognizes a package.json that lists workspaces as the root', () => {
    rmSync(join(root, 'pnpm-workspace.yaml'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['sites/*'] }))
    const ext = pkg('extensions/effects')
    expect(findSiteExtension('effects', site('sites/main'))).toBe(ext)
  })

  it('outside any workspace, looks only in the folder the site is in', () => {
    const lone = mkdtempSync(join(tmpdir(), 'uw-lone-'))
    try {
      mkdirSync(join(lone, 'a', 'site'), { recursive: true })
      expect(extensionSearchDirs(join(lone, 'a'))).toEqual([join(lone, 'a')])
    } finally {
      rmSync(lone, { recursive: true, force: true })
    }
  })

  it('searches nearest first, both spellings at each level, up to the root', () => {
    site('sites/main')
    expect(extensionCandidates('fx', join(root, 'sites'))).toEqual([
      join(root, 'sites', 'fx'),
      join(root, 'sites', 'extensions', 'fx'),
      join(root, 'fx'),
      join(root, 'extensions', 'fx')
    ])
  })

  it('takes a name, never a path', () => {
    pkg('effects')
    for (const bad of ['', '.', '..', '../effects', 'a/b', 'a\\b']) {
      expect(findExtensionPackage(bad, root)).toBeNull()
    }
    expect(findExtensionPackage('effects', root)).toBe(join(root, 'effects'))
  })
})

describe('extensionNameOf — the extension a site-relative URL names', () => {
  it('is the first segment', () => {
    expect(extensionNameOf('/effects/entry.js')).toEqual({ name: 'effects', rest: 'entry.js' })
    expect(extensionNameOf('/effects/assets/style.css')).toEqual({ name: 'effects', rest: 'assets/style.css' })
  })

  it('once the deployment base is removed — the payload carries it', () => {
    expect(extensionNameOf('/docs/effects/entry.js', '/docs/')).toEqual({ name: 'effects', rest: 'entry.js' })
    // CONTROL: without the base, the first segment is the base's.
    expect(extensionNameOf('/docs/effects/entry.js').name).toBe('docs')
  })

  it('without a query or fragment', () => {
    expect(extensionNameOf('/effects/entry.js?v=2')).toEqual({ name: 'effects', rest: 'entry.js' })
  })

  it('is nothing for a URL that is not site-relative, or names no file in a folder', () => {
    for (const url of ['https://cdn.example.com/fx/entry.js', '//cdn/fx.js', '@acme/fx@1.0.0', '/entry.js', null]) {
      expect(extensionNameOf(url)).toBeNull()
    }
  })
})
