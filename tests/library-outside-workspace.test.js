/**
 * A library outside the workspace's folder, listed in the workspace, builds as part of the foundation
 * that bundles it (`src/foundation/library-imports.js`), and one a package manager copied is said
 * (`copiedLibraries`).
 *
 * Measured 2026-11-10 with the folder listed in `pnpm-workspace.yaml` and `package.json` `workspaces`:
 *   - pnpm 10.30 linked it and installed its dependencies in its folder, so it resolves them itself;
 *   - npm 10.9 linked it at the workspace's root and hoisted its dependencies there, where Node never
 *     looks from the library's folder: the foundation build stopped, `Rollup failed to resolve import
 *     "@uniweb/kit"`, until its imports resolved as the foundation's.
 * These builds lay out the two by hand.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'vite'
import { libraryImports, librariesOutside } from '../src/foundation/library-imports.js'
import { copiedLibraries, copiedLibrariesWarning } from '../src/foundation/libraries.js'
import { libraryLine, unreadLibraries } from '../src/foundation/stale-sources.js'

const roots = []
const locked = []
afterEach(() => {
  locked.splice(0).forEach((d) => chmodSync(d, 0o755))
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

const pkg = (name, extra = {}) => JSON.stringify({ name, type: 'module', main: 'index.js', ...extra })

/**
 * `top/ws/src`, a foundation depending on the library `acme-shared`, which uses its peer `fake-kit`,
 * its own dependency `own-dep`, and the library `tokens`.
 *   'npm':    both libraries in `top/`, linked at `ws/node_modules`, and everything hoisted there;
 *   'pnpm':   both in `top/`, each linked where its dependent's `node_modules` is, and its
 *             dependencies installed in its own folder;
 *   'inside': laid out as 'npm', with both libraries in the workspace's folder.
 */
function workspace(layout) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'uw-outside-lib-')))
  roots.push(top)
  const ws = join(top, 'ws')
  const home = layout === 'inside' ? join(ws, 'libraries') : top
  const lib = join(home, 'acme-shared')
  const tokens = join(home, 'tokens')
  write(lib, {
    'package.json': pkg('acme-shared', {
      exports: { '.': './index.js', './styles.css': './styles.css' },
      dependencies: { 'own-dep': '*', tokens: 'file:../tokens' },
      peerDependencies: { 'fake-kit': '*' }
    }),
    'index.js': "import { tag } from 'fake-kit'\nimport { own } from 'own-dep'\nimport { tone } from 'tokens'\nexport const Card = () => tag(own + ' ' + tone())\n",
    'styles.css': '@source "./**/*.js";\n.acme-card { color: red; }\n'
  })
  write(tokens, { 'package.json': pkg('tokens'), 'index.js': "export const tone = () => 'a tone from tokens'\n" })
  const fakeKit = { 'package.json': pkg('fake-kit'), 'index.js': "export const tag = (words) => 'kit:' + words\n" }
  const ownDep = { 'package.json': pkg('own-dep'), 'index.js': "export const own = 'the library’s own dependency'\n" }
  const install = (at, name, files) => write(join(at, 'node_modules', name), files)
  const link = (at, name, target) => {
    mkdirSync(join(at, 'node_modules'), { recursive: true })
    symlinkSync(target, join(at, 'node_modules', name))
  }
  write(ws, {
    'pnpm-workspace.yaml': `packages:\n  - src\n  - '${layout === 'inside' ? 'libraries/*' : '../*'}'\n`,
    'src/package.json': pkg('src', { dependencies: { 'acme-shared': layout === 'inside' ? 'file:../libraries/acme-shared' : 'file:../../acme-shared', 'fake-kit': '*' } }),
    'src/entry.js': "import './styles.css'\nimport { Card } from 'acme-shared'\nexport default Card\n",
    'src/styles.css': '@import "acme-shared/styles.css";\n'
  })
  if (layout === 'pnpm') {
    install(join(ws, 'src'), 'fake-kit', fakeKit)
    link(join(ws, 'src'), 'acme-shared', lib)
    install(lib, 'fake-kit', fakeKit)
    install(lib, 'own-dep', ownDep)
    link(lib, 'tokens', tokens)
  } else {
    install(ws, 'fake-kit', fakeKit)
    install(ws, 'own-dep', ownDep)
    link(ws, 'acme-shared', lib)
    link(ws, 'tokens', tokens)
  }
  return { top, ws, src: join(ws, 'src'), lib }
}

/** Build the foundation's entry, with the plugin or without; its JS and CSS. */
async function bundle(src, { plugin }) {
  const outDir = join(src, plugin ? 'dist-plugin' : 'dist-plain')
  await build({
    root: src,
    configFile: false,
    logLevel: 'silent',
    plugins: plugin ? [libraryImports({ foundationDir: src })] : [],
    build: { outDir, emptyOutDir: true, cssCodeSplit: false, lib: { entry: join(src, 'entry.js'), formats: ['es'], fileName: () => 'entry.js' } }
  })
  const files = readdirSync(outDir, { recursive: true }).map(String)
  const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(outDir, f), 'utf8')).join('')
  return { js: readFileSync(join(outDir, 'entry.js'), 'utf8'), css }
}

describe('a library outside the workspace’s folder, under npm', () => {
  it('⭐ builds: its peer, its own dependency and the library it uses resolve as the foundation’s', async () => {
    const { src } = workspace('npm')
    const { js, css } = await bundle(src, { plugin: true })
    expect(js).toContain('kit:')
    expect(js).toContain('the library’s own dependency')
    expect(js).toContain('a tone from tokens')
    expect(css).toContain('.acme-card')
  })

  it('CONTROL: without the plugin, the build stops on what the library imports', async () => {
    const { src } = workspace('npm')
    await expect(bundle(src, { plugin: false })).rejects.toThrow(/fake-kit|own-dep|tokens/)
  })
})

describe('a library outside the workspace’s folder, under pnpm', () => {
  it('builds the same with the plugin as without: it resolves its own installs', async () => {
    const { src } = workspace('pnpm')
    const plain = await bundle(src, { plugin: false })
    const ruled = await bundle(src, { plugin: true })
    expect(ruled.js).toBe(plain.js)
    expect(ruled.css).toBe(plain.css)
    expect(plain.js).toContain('a tone from tokens')
  })
})

describe('a library inside the workspace’s folder', () => {
  it('CONTROL: the plugin leaves it alone', async () => {
    const { src } = workspace('inside')
    expect(librariesOutside(src)).toEqual([])
    const plain = await bundle(src, { plugin: false })
    const ruled = await bundle(src, { plugin: true })
    expect(ruled.js).toBe(plain.js)
    expect(ruled.css).toBe(plain.css)
  })
})

describe('copiedLibraries', () => {
  it('⭐ names a library installed as a copy, with the line that links it', () => {
    const { ws, src, lib } = workspace('npm')
    // pnpm's copy of a `file:` package the workspace doesn't list: in its store, not a link.
    rmSync(join(ws, 'node_modules', 'acme-shared'))
    const store = join(ws, 'node_modules', '.pnpm', 'acme-shared@file+..+acme-shared', 'node_modules', 'acme-shared')
    write(store, { 'package.json': pkg('acme-shared'), 'index.js': 'export const Card = () => "old"\n' })
    mkdirSync(join(src, 'node_modules'), { recursive: true })
    symlinkSync(store, join(src, 'node_modules', 'acme-shared'))
    const copied = copiedLibraries(src)
    expect(copied.map((c) => [c.name, c.dir])).toEqual([['acme-shared', lib]])
    expect(copiedLibrariesWarning(copied, ws)).toMatch(/acme-shared is installed as a copy[\s\S]*pnpm-workspace\.yaml: {2}- '\.\.\/acme-shared'/)
  })

  it('CONTROL: names none the package manager linked', () => {
    expect(copiedLibraries(workspace('npm').src)).toEqual([])
    expect(copiedLibraries(workspace('pnpm').src)).toEqual([])
  })
})

describe("the line that has a foundation's stylesheet read a library", () => {
  const lib = (exports, styles) => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'uw-line-')))
    roots.push(top)
    write(top, {
      'ui/package.json': JSON.stringify({ name: 'ui', ...(exports !== undefined && { exports }) }),
      ...(styles !== undefined && { 'ui/styles.css': styles })
    })
    return { lib: { name: 'ui', dir: join(top, 'ui') }, stylesDir: join(top, 'classic') }
  }

  it('imports the stylesheet that reads the library, when the library exports it', () => {
    const exported = lib({ '.': './index.js', './styles.css': './styles.css' }, '@source "./";\n')
    expect(libraryLine(exported.lib, exported.stylesDir)).toBe('@import "ui/styles.css";')
    const open = lib(undefined, '@source "./**/*.js";\n')
    expect(libraryLine(open.lib, open.stylesDir)).toBe('@import "ui/styles.css";')
  })

  it('a @source to its folder when its exports are a string, which exports "." alone', () => {
    const { lib: l, stylesDir } = lib('./index.js', '@source "./";\n')
    expect(libraryLine(l, stylesDir)).toBe('@source "../ui";')
  })

  it('a @source to its folder when its stylesheet reads none of its files', () => {
    const { lib: l, stylesDir } = lib(undefined, '.plain { color: red; }\n')
    expect(libraryLine(l, stylesDir)).toBe('@source "../ui";')
  })
})

describe('unreadLibraries', () => {
  const foundation = (styles) => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'uw-unread-')))
    roots.push(top)
    write(top, {
      'classic/package.json': JSON.stringify({ name: 'classic', dependencies: { 'acme-shared': 'file:../acme-shared' } }),
      'classic/styles.css': styles,
      'acme-shared/package.json': JSON.stringify({ name: 'acme-shared', exports: { './styles.css': './styles.css' } }),
      'acme-shared/styles.css': '@source "./**/*.jsx";\n',
      'acme-shared/Card.jsx': 'export default () => <div className="p-4 text-heading" />\n'
    })
    return { top, dir: join(top, 'classic') }
  }

  it("⭐ before an install, the library's stylesheet import already reads it", () => {
    const { dir } = foundation('@import "tailwindcss";\n@import "acme-shared/styles.css";\n')
    expect(unreadLibraries(join(dir, 'styles.css'), dir)).toEqual([])
  })

  it('CONTROL: without the import, it names the library and the line', () => {
    const { dir } = foundation('@import "tailwindcss";\n')
    expect(unreadLibraries(join(dir, 'styles.css'), dir).map((u) => u.line)).toEqual(['@import "acme-shared/styles.css";'])
  })

  it('a folder in the library it may not read stops nothing', () => {
    const { top, dir } = foundation('@import "tailwindcss";\n')
    const folder = join(top, 'acme-shared', 'locked')
    mkdirSync(folder)
    chmodSync(folder, 0o000)
    locked.push(folder)
    expect(() => unreadLibraries(join(dir, 'styles.css'), dir)).not.toThrow()
  })
})

describe('the configs that build a foundation’s source', () => {
  const inDir = async (dir, run) => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      return await run()
    } finally {
      process.chdir(cwd)
    }
  }

  it("the foundation's build and a site's carry the plugin, and change nothing else", async () => {
    const { ws, src } = workspace('npm')
    const { defineFoundationConfig } = await import('../src/foundation/config.js')
    const config = await inDir(src, () => defineFoundationConfig({ tailwind: false }))
    expect(config.plugins.map((p) => p?.name)).toContain('uniweb:library-imports')
    expect(config.resolve).toBeUndefined()

    write(ws, {
      'site/site.yml': 'name: Test\nfoundation: src\n',
      'site/package.json': JSON.stringify({ name: 'site', dependencies: { src: 'file:../src' } }),
      'site/pages/home/page.yml': 'title: Home\n',
      'src/main.js': 'export default {}\n'
    })
    const { defineSiteConfig } = await import('../src/site/config.js')
    const site = await inDir(join(ws, 'site'), () => defineSiteConfig())
    expect(site.plugins.flat().map((p) => p?.name)).toContain('uniweb:library-imports')
    expect(Array.isArray(site.resolve.alias)).toBe(false)
    expect(site.optimizeDeps.exclude).toEqual(['#foundation'])
  })
})
