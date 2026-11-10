/**
 * Which local packages a foundation bundles — `src/foundation/libraries.js`.
 *
 * A library is any local package a foundation depends on, and its files are the foundation's
 * sources too. Measured 2026-11-09: with only a library's file changed, `uniweb build` kept the
 * foundation's old `dist/`, and the prerendered page had the old component while the site's JS had
 * the new one, because the freshness check walked the foundation's own folder alone.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { librariesOf as librariesWithDependents } from '../src/foundation/libraries.js'

// Each library as these tests name it: by its name and folder (`from`, the package depending on
// it, has a test of its own below).
const librariesOf = (dir) => librariesWithDependents(dir).map(({ name, dir: at }) => ({ name, dir: at }))

const roots = []
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A workspace folder; its real path, since a macOS temp folder is behind a link. */
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uw-libraries-')))
  roots.push(root)
  return root
}

function pkg(dir, json) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
  return dir
}

/** `node_modules/<name>` in `fromDir`, linked to `target`, as pnpm and npm link a local package. */
function link(fromDir, name, target) {
  const at = join(fromDir, 'node_modules', name)
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, 'dir')
}

const names = (libs) => libs.map((l) => l.name)

describe('a local package a foundation depends on is a library', () => {
  test('each with the package that depends on it: the foundation, or the library that uses it', () => {
    const ws = workspace()
    const tokens = pkg(join(ws, 'tokens'), { name: 'tokens' })
    const ui = pkg(join(ws, 'ui'), { name: 'ui', dependencies: { tokens: 'file:../tokens' } })
    const classic = pkg(join(ws, 'classic'), { name: 'classic', dependencies: { ui: 'file:../ui' } })
    expect(librariesWithDependents(classic).map(({ name, from }) => [name, from])).toEqual([
      ['ui', classic],
      ['tokens', ui]
    ])
    expect(tokens).toBe(join(ws, 'tokens'))
  })

  test('⭐ the recipe: a package beside it, by a `file:` path', () => {
    const ws = workspace()
    const shared = pkg(join(ws, 'shared'), { name: '@acme/shared' })
    const classic = pkg(join(ws, 'classic'), { name: 'classic', dependencies: { '@acme/shared': 'file:../shared' } })
    link(classic, '@acme/shared', shared)
    expect(librariesOf(classic)).toEqual([{ name: '@acme/shared', dir: shared }])
  })

  test('a `file:` path names the folder to edit before any install', () => {
    const ws = workspace()
    const shared = pkg(join(ws, 'libraries', 'ui'), { name: 'ui' })
    const classic = pkg(join(ws, 'foundations', 'classic'), { dependencies: { ui: 'file:../../libraries/ui' } })
    expect(librariesOf(classic)).toEqual([{ name: 'ui', dir: shared }])
  })

  test("pnpm's copy of a `file:` package from outside the workspace: the folder it names, not the copy", () => {
    const ws = workspace()
    const outside = pkg(join(ws, 'acme-shared'), { name: '@acme/shared' })
    const classic = pkg(join(ws, 'project', 'classic'), { dependencies: { '@acme/shared': 'file:../../acme-shared' } })
    const copy = pkg(join(ws, 'project', 'node_modules', '.pnpm', 'acme-shared@file+..+acme-shared', 'node_modules', '@acme', 'shared'), {
      name: '@acme/shared'
    })
    link(classic, '@acme/shared', copy)
    expect(librariesOf(classic)).toEqual([{ name: '@acme/shared', dir: outside }])
  })

  test('a `link:` path, and a `workspace:` spec found where pnpm linked it', () => {
    const ws = workspace()
    const a = pkg(join(ws, 'a'), { name: 'a' })
    const b = pkg(join(ws, 'b'), { name: 'b' })
    const classic = pkg(join(ws, 'classic'), { dependencies: { a: 'link:../a', b: 'workspace:*' } })
    link(classic, 'b', b)
    expect(librariesOf(classic)).toEqual([
      { name: 'a', dir: a },
      { name: 'b', dir: b }
    ])
  })

  test('a version range npm hoisted to the root, linked to the workspace package', () => {
    const ws = workspace()
    const shared = pkg(join(ws, 'shared'), { name: '@acme/shared' })
    const classic = pkg(join(ws, 'classic'), { dependencies: { '@acme/shared': '*' } })
    link(ws, '@acme/shared', shared)
    expect(librariesOf(classic)).toEqual([{ name: '@acme/shared', dir: shared }])
  })

  test('the foundation’s devDependencies count: it bundles what it imports, whichever list names it', () => {
    const ws = workspace()
    const shared = pkg(join(ws, 'shared'), { name: 'shared' })
    const classic = pkg(join(ws, 'classic'), { devDependencies: { shared: 'file:../shared' } })
    expect(names(librariesOf(classic))).toEqual(['shared'])
    expect(librariesOf(classic)[0].dir).toBe(shared)
  })
})

describe('what is not a library', () => {
  test('CONTROL: an installed package, a copy of a release inside node_modules', () => {
    const ws = workspace()
    const classic = pkg(join(ws, 'classic'), { dependencies: { '@uniweb/kit': '~1.7.18', lodash: '^4' } })
    const kit = pkg(join(ws, 'node_modules', '.pnpm', '@uniweb+kit@1.7.18', 'node_modules', '@uniweb', 'kit'), { name: '@uniweb/kit' })
    link(classic, '@uniweb/kit', kit)
    pkg(join(classic, 'node_modules', 'lodash'), { name: 'lodash' })
    expect(librariesOf(classic)).toEqual([])
  })

  test('a package the build leaves to the runtime, even linked from the workspace', () => {
    const ws = workspace()
    const core = pkg(join(ws, 'core'), { name: '@uniweb/core' })
    const classic = pkg(join(ws, 'classic'), { dependencies: { '@uniweb/core': 'workspace:*' } })
    link(classic, '@uniweb/core', core)
    expect(librariesOf(classic)).toEqual([])
  })

  test('peerDependencies, which the foundation provides', () => {
    const ws = workspace()
    pkg(join(ws, 'kit'), { name: '@uniweb/kit' })
    const shared = pkg(join(ws, 'shared'), { name: 'shared', peerDependencies: { '@uniweb/kit': 'file:../kit' } })
    const classic = pkg(join(ws, 'classic'), { dependencies: { shared: 'file:../shared' } })
    expect(librariesOf(classic)).toEqual([{ name: 'shared', dir: shared }])
  })

  test("a library's devDependencies, which are its own tools", () => {
    const ws = workspace()
    pkg(join(ws, 'test-helpers'), { name: 'test-helpers' })
    const shared = pkg(join(ws, 'shared'), { name: 'shared', devDependencies: { 'test-helpers': 'file:../test-helpers' } })
    const classic = pkg(join(ws, 'classic'), { dependencies: { shared: 'file:../shared' } })
    expect(librariesOf(classic)).toEqual([{ name: 'shared', dir: shared }])
  })

  test('a `file:` tarball, and a path that leads nowhere', () => {
    const ws = workspace()
    writeFileSync(join(ws, 'x.tgz'), '')
    const classic = pkg(join(ws, 'classic'), { dependencies: { x: 'file:../x.tgz', gone: 'file:../gone' } })
    expect(librariesOf(classic)).toEqual([])
  })
})

describe("a library's libraries", () => {
  test('are the foundation’s too, each once', () => {
    const ws = workspace()
    const tokens = pkg(join(ws, 'tokens'), { name: 'tokens' })
    const ui = pkg(join(ws, 'ui'), { name: 'ui', dependencies: { tokens: 'file:../tokens' } })
    const data = pkg(join(ws, 'data'), { name: 'data', dependencies: { tokens: 'file:../tokens' } })
    const classic = pkg(join(ws, 'classic'), { dependencies: { ui: 'file:../ui', data: 'file:../data' } })
    expect(librariesOf(classic)).toEqual([
      { name: 'ui', dir: ui },
      { name: 'tokens', dir: tokens },
      { name: 'data', dir: data }
    ])
  })

  test('a library that depends back on the foundation ends there', () => {
    const ws = workspace()
    const ui = pkg(join(ws, 'ui'), { name: 'ui', dependencies: { classic: 'file:../classic' } })
    const classic = pkg(join(ws, 'classic'), { name: 'classic', dependencies: { ui: 'file:../ui' } })
    expect(librariesOf(classic)).toEqual([{ name: 'ui', dir: ui }])
  })

  test('a package with no package.json has none', () => {
    const ws = workspace()
    mkdirSync(join(ws, 'bare'))
    expect(librariesOf(join(ws, 'bare'))).toEqual([])
  })
})
