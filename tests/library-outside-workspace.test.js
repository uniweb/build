/**
 * A library outside the workspace builds as part of the foundation that bundles it
 * (`src/foundation/library-imports.js`).
 *
 * Measured 2026-11-10 on workspaces made with `uniweb` 1.31.6, a library beside each linked by path:
 *   - under npm (`file:`, a symlink), the foundation build stopped, `Rollup failed to resolve import
 *     "@uniweb/kit"` from the library, since nothing is installed beside it;
 *   - under pnpm (`file:`, a hard-linked copy), the build read the copy, so a file added to the
 *     library, or saved by an editor that replaces the file, never reached it without `pnpm install`.
 * These builds lay the two out by hand: a symlink, as npm makes, and a copy older than the folder,
 * as pnpm's falls behind.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'vite'
import { libraryImports, libraryAliases, libraryNames } from '../src/foundation/library-imports.js'
import { inLibraryFolder, librariesOf } from '../src/foundation/libraries.js'
import { unreadLibraries } from '../src/foundation/stale-sources.js'

const roots = []
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

const LIBRARY = (words) => ({
  'package.json': JSON.stringify({
    name: 'acme-shared',
    type: 'module',
    exports: { '.': './index.js', './styles.css': './styles.css', './components/*': './components/*' },
    peerDependencies: { 'fake-kit': '*' }
  }),
  'index.js': "export { default as Card } from './components/Card.js'\n",
  'components/Card.js': `import { tag } from 'fake-kit'\nexport default function Card() { return tag('${words}') }\n`,
  'styles.css': `.acme-card { content: '${words}'; }\n`
})

/**
 * `top/ws/src`, a foundation depending on `acme-shared`; `fake-kit`, the peer, installed at the
 * workspace's root. `where`: 'linked' (npm: a symlink to `top/acme-shared`), 'copied' (pnpm: a copy
 * in the store, older than the folder, with `own-dep`, a dependency of the library's own, beside it,
 * and the foundation's node_modules linking the copy) or 'inside' (a library of the workspace).
 */
function workspace(where) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'uw-outside-lib-')))
  roots.push(top)
  const ws = join(top, 'ws')
  const libDir = where === 'inside' ? join(ws, 'libraries', 'acme-shared') : join(top, 'acme-shared')
  write(libDir, LIBRARY('from the folder'))
  write(ws, {
    'node_modules/fake-kit/package.json': JSON.stringify({ name: 'fake-kit', type: 'module', main: 'index.js' }),
    'node_modules/fake-kit/index.js': "export const tag = (words) => 'kit:' + words\n",
    'src/package.json': JSON.stringify({
      name: 'src',
      type: 'module',
      dependencies: { 'acme-shared': where === 'inside' ? 'file:../libraries/acme-shared' : 'file:../../acme-shared' }
    }),
    'src/entry.js': "import './styles.css'\nimport { Card } from 'acme-shared'\nexport default Card\n",
    'src/styles.css': '@import "acme-shared/styles.css";\n'
  })
  if (where === 'copied') {
    const store = join(ws, 'node_modules', '.pnpm', 'acme-shared@file+..+acme-shared', 'node_modules')
    write(join(store, 'acme-shared'), LIBRARY('from the copy'))
    write(join(store, 'own-dep'), {
      'package.json': JSON.stringify({ name: 'own-dep', type: 'module', main: 'index.js' }),
      'index.js': "export const own = 'the library’s own dependency'\n"
    })
    mkdirSync(join(ws, 'src', 'node_modules'), { recursive: true })
    symlinkSync(join(store, 'acme-shared'), join(ws, 'src', 'node_modules', 'acme-shared'))
  } else {
    mkdirSync(join(ws, 'node_modules'), { recursive: true })
    symlinkSync(libDir, join(ws, 'node_modules', 'acme-shared'))
  }
  return { top, ws, src: join(ws, 'src'), libDir }
}

/** Build the foundation's entry, with the library rules or without; its JS and CSS. */
async function bundle(src, { rules }) {
  const outDir = join(src, rules ? 'dist-rules' : 'dist-plain')
  await build({
    root: src,
    configFile: false,
    logLevel: 'silent',
    plugins: rules ? [libraryImports({ foundationDir: src })] : [],
    ...(rules && { resolve: { alias: libraryAliases(src) } }),
    build: {
      outDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      lib: { entry: join(src, 'entry.js'), formats: ['es'], fileName: () => 'entry.js' }
    }
  })
  const files = readdirSync(outDir, { recursive: true }).map(String)
  const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(outDir, f), 'utf8')).join('')
  return { js: readFileSync(join(outDir, 'entry.js'), 'utf8'), css }
}

describe('a library outside the workspace, linked (npm)', () => {
  it("⭐ builds: the library's peer resolves from the foundation", async () => {
    const { src } = workspace('linked')
    const { js, css } = await bundle(src, { rules: true })
    expect(js).toContain('kit:')
    expect(js).toContain('from the folder')
    expect(css).toContain('from the folder')
  })

  it('CONTROL: without the rules, the build stops on the peer', async () => {
    const { src } = workspace('linked')
    await expect(bundle(src, { rules: false })).rejects.toThrow(/fake-kit/)
  })
})

describe('a library outside the workspace, copied (pnpm)', () => {
  it('⭐ is read from its folder, its code and its stylesheet, not from the copy', async () => {
    const { src } = workspace('copied')
    const { js, css } = await bundle(src, { rules: true })
    expect(js).toContain('from the folder')
    expect(js).not.toContain('from the copy')
    expect(css).toContain('from the folder')
    expect(css).not.toContain('from the copy')
  })

  it('a file added to the library since the install reaches the build', async () => {
    const { src, libDir } = workspace('copied')
    write(libDir, {
      'components/Badge.js': "export default () => 'a badge added later'\n",
      'index.js': "export { default as Card } from './components/Card.js'\nexport { default as Badge } from './components/Badge.js'\n"
    })
    write(src, { 'entry.js': "import './styles.css'\nimport { Card, Badge } from 'acme-shared'\nexport default [Card, Badge]\n" })
    const { js } = await bundle(src, { rules: true })
    expect(js).toContain('a badge added later')
  })

  it('a dependency of the library’s own resolves where the package manager installed it, beside the copy', async () => {
    const { src, libDir } = workspace('copied')
    write(libDir, { 'components/Card.js': "import { own } from 'own-dep'\nexport default function Card() { return own }\n" })
    const { js } = await bundle(src, { rules: true })
    expect(js).toContain('the library’s own dependency')
  })

  it('CONTROL: without the rules, the build reads the copy', async () => {
    const { src } = workspace('copied')
    const { js, css } = await bundle(src, { rules: false })
    expect(js).toContain('from the copy')
    expect(css).toContain('from the copy')
  })

  it("the stylesheet check reads the library's stylesheet from its folder too: no false warning", () => {
    const { src } = workspace('copied')
    write(src, {
      'styles.css': '@import "tailwindcss";\n@import "acme-shared/styles.css";\n'
    })
    write(join(src, '..', '..', 'acme-shared'), {
      'styles.css': '@source "./**/*.js";\n',
      'components/Card.js': "export default () => <div className=\"p-4 text-heading\" />\n"
    })
    expect(unreadLibraries(join(src, 'styles.css'), src)).toEqual([])
  })
})

describe('a library inside the workspace', () => {
  it('CONTROL: builds the same with the rules and without', async () => {
    const { src } = workspace('inside')
    const plain = await bundle(src, { rules: false })
    const ruled = await bundle(src, { rules: true })
    expect(ruled.js).toBe(plain.js)
    expect(ruled.css).toBe(plain.css)
    expect(libraryAliases(src)).toEqual([])
  })
})

describe('inLibraryFolder', () => {
  it('maps a path in a copy to the same path in the folder, and leaves others', () => {
    const { src, libDir } = workspace('copied')
    const libraries = librariesOf(src)
    const copy = realpathSync(join(src, 'node_modules', 'acme-shared'))
    expect(inLibraryFolder(join(copy, 'components', 'Card.js'), libraries)).toBe(join(libDir, 'components', 'Card.js'))
    expect(inLibraryFolder(join(src, 'entry.js'), libraries)).toBe(join(src, 'entry.js'))
    expect(inLibraryFolder(join(copy, 'components', 'Card.js'), [])).toBe(join(copy, 'components', 'Card.js'))
  })
})

describe('libraryAliases', () => {
  it("follows the library's exports: an exact stylesheet and a pattern", () => {
    const { src, libDir } = workspace('copied')
    const aliases = libraryAliases(src)
    const to = (spec) => {
      const hit = aliases.find((a) => a.find.test(spec))
      return hit ? spec.replace(hit.find, hit.replacement) : null
    }
    expect(to('acme-shared/styles.css')).toBe(join(libDir, 'styles.css'))
    expect(to('acme-shared/components/card.css')).toBe(`${libDir}/components/card.css`)
    expect(to('acme-shared')).toBe(null)
    expect(to('acme-shared/index.js')).toBe(null)
  })

  it('names nothing for a library the package manager linked', () => {
    const { src } = workspace('linked')
    expect(libraryAliases(src)).toEqual([])
    expect(libraryNames(src)).toEqual(['acme-shared'])
  })
})

describe('the configs that build a foundation’s source carry the rules', () => {
  const inDir = async (dir, run) => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      return await run()
    } finally {
      process.chdir(cwd)
    }
  }

  it("the foundation's build: the plugin, and an alias only for a library installed as a copy", async () => {
    const { defineFoundationConfig } = await import('../src/foundation/config.js')
    const copied = workspace('copied')
    const config = await inDir(copied.src, () => defineFoundationConfig({ tailwind: false }))
    expect(config.plugins.map((p) => p?.name)).toContain('uniweb:library-imports')
    expect(config.resolve.alias.map((a) => String(a.find))).toContain('/^acme-shared\\/styles\\.css$/')

    const linked = workspace('linked')
    const plain = await inDir(linked.src, () => defineFoundationConfig({ tailwind: false }))
    expect(plain.resolve).toBeUndefined()
  })

  it("a site's build and dev server: the plugin, and the library never pre-bundled", async () => {
    const { ws } = workspace('copied')
    write(ws, {
      'site/site.yml': 'name: Test\nfoundation: src\n',
      'site/package.json': JSON.stringify({ name: 'site', dependencies: { src: 'file:../src' } }),
      'site/pages/home/page.yml': 'title: Home\n',
      'src/main.js': 'export default {}\n'
    })
    const { defineSiteConfig } = await import('../src/site/config.js')
    const config = await inDir(join(ws, 'site'), () => defineSiteConfig())
    expect(config.plugins.flat().map((p) => p?.name)).toContain('uniweb:library-imports')
    expect(config.optimizeDeps.exclude).toContain('acme-shared')
    expect(config.resolve.alias.map((a) => String(a.find))).toContain('/^acme-shared\\/styles\\.css$/')
    expect(config.resolve.alias.find((a) => a.find === '#foundation')?.replacement).toBe('src')
  })

  it('CONTROL: a site whose foundation has no library keeps its aliases as an object', async () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'uw-no-lib-')))
    roots.push(top)
    write(top, {
      'site/site.yml': 'name: Test\nfoundation: src\n',
      'site/package.json': JSON.stringify({ name: 'site', dependencies: { src: 'file:../src' } }),
      'site/pages/home/page.yml': 'title: Home\n',
      'src/package.json': JSON.stringify({ name: 'src', type: 'module', main: './_entry.generated.js' }),
      'src/main.js': 'export default {}\n'
    })
    const { defineSiteConfig } = await import('../src/site/config.js')
    const config = await inDir(join(top, 'site'), () => defineSiteConfig())
    expect(Array.isArray(config.resolve.alias)).toBe(false)
    expect(config.resolve.alias['#foundation']).toBe('src')
    expect(config.optimizeDeps.exclude).toEqual(['#foundation'])
  })
})
