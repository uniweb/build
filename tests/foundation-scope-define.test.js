/**
 * ⭐ `__FOUNDATION_SCOPE__` — THE SCOPE A FOUNDATION'S OWN `@/x` NAMES, IN ITS BUNDLE.
 *
 * A foundation names its own types `@/x` in its calls to the site's backend, and a backend holds
 * them under `@<scope>/x`, the name `register` stored them under. Only the build knows the scope,
 * so it stamps it: the scope in the foundation's name in a build that ships, null in a working
 * copy (`uniweb dev`), where `@/x` is sent as written — the way a local mock holds the foundation's
 * own types [Diego, 2026-10-17]. `@uniweb/api` reads it, and refuses `@/x` where nothing set it.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, createServer } from 'vite'
import { foundationScopeDefine } from '../src/foundation/scope-define.js'
import { DEV_REBUILD_MARKER } from '../src/foundation/dev-rebuild.js'
import { defineFoundationConfig } from '../src/foundation/config.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const READ = "typeof __FOUNDATION_SCOPE__ === 'undefined' ? 'unset' : __FOUNDATION_SCOPE__"

// A foundation named `name` (none: no name at all), whose own code and a dependency of it read the
// constant — the dependency the way `@uniweb/api` does, from `node_modules`.
function foundation(name, { pkg = {} } = {}) {
  const dir = mkdtempSync(join(HERE, '.tmp-scope-'))
  dirs.push(dir)
  const files = {
    'package.json': JSON.stringify({ name: 'src', type: 'module', main: './_entry.generated.js', ...pkg }),
    'main.js': `export default ${name ? `{ name: '${name}' }` : '{}'}\n`,
    'entry.js': `export { depScope } from 'reads-scope'\nexport const own = ${READ}\n`,
    'node_modules/reads-scope/package.json': JSON.stringify({ name: 'reads-scope', type: 'module', main: 'index.js' }),
    'node_modules/reads-scope/index.js': `export const depScope = ${READ}\n`,
  }
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

// Build it in library mode, as a foundation builds, and load what came out.
async function built(dir, { plugins = [foundationScopeDefine({ foundationDir: dir })], define } = {}) {
  await build({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    plugins,
    define,
    build: {
      lib: { entry: join(dir, 'entry.js'), formats: ['es'], fileName: 'entry' },
      outDir: join(dir, 'dist'),
      minify: false,
    },
  })
  const { own, depScope } = await import(pathToFileURL(join(dir, 'dist', 'entry.js')).href)
  return { own, depScope }
}

describe('a foundation build', () => {
  it('control: with nothing set, the bundle reads no scope', async () => {
    expect(await built(foundation('@acme/marketing'), { plugins: [] })).toEqual({ own: 'unset', depScope: 'unset' })
  })

  it('⭐ stamps the scope in the foundation’s name — in its own code and in a dependency’s', async () => {
    expect(await built(foundation('@acme/marketing'))).toEqual({ own: '@acme', depScope: '@acme' })
  })

  it('a name with no scope yet stamps null — `@/x` stays as written', async () => {
    expect(await built(foundation('marketing'))).toEqual({ own: null, depScope: null })
    expect(await built(foundation(null))).toEqual({ own: null, depScope: null })
  })

  it('a leftover `uniweb.scope` is `register`’s to refuse, not the build’s — the scope in the name is stamped', async () => {
    expect(await built(foundation('@acme/marketing', { pkg: { uniweb: { scope: '@other' } } }))).toEqual({ own: '@acme', depScope: '@acme' })
  })

  it('a `main.js` that does not load stops the build, as it stops the schema', async () => {
    const dir = foundation('@acme/marketing')
    writeFileSync(join(dir, 'main.js'), "throw new Error('main.js would not load')\n")
    await expect(built(dir)).rejects.toThrow(/main\.js would not load/)
  })

  it('an author’s own define wins', async () => {
    const dir = foundation('@acme/marketing')
    expect(await built(dir, { define: { __FOUNDATION_SCOPE__: JSON.stringify('@mine') } })).toEqual({ own: '@mine', depScope: '@mine' })
  })

  it('`defineFoundationConfig` carries it, as it carries the NODE_ENV define', async () => {
    const config = await defineFoundationConfig()
    expect(config.plugins.map((p) => p.name)).toContain('uniweb:foundation-scope')
  })
})

describe('a site that bundles its foundation', () => {
  let cwd
  afterEach(() => {
    if (cwd) process.chdir(cwd)
    cwd = undefined
    delete process.env.VITE_FOUNDATION_MODE
  })

  // A workspace: `site/` on the foundation `src/`, named `@acme/marketing`.
  function site() {
    const root = mkdtempSync(join(HERE, '.tmp-scope-site-'))
    dirs.push(root)
    const files = {
      'site/site.yml': 'name: Test\nfoundation: src\n',
      'site/package.json': JSON.stringify({ name: 'site', dependencies: { src: 'file:../src' } }),
      'site/pages/home/page.yml': 'title: Home\n',
      'src/package.json': JSON.stringify({ name: 'src', type: 'module', main: './_entry.generated.js' }),
      'src/main.js': "export default { name: '@acme/marketing' }\n",
    }
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    cwd = process.cwd()
    process.chdir(join(root, 'site'))
  }
  const scopePlugin = (config) => config.plugins.find((p) => p?.name === 'uniweb:foundation-scope')

  it('⭐ compiles the foundation, so its build sets the foundation’s scope — and `uniweb dev`, null', async () => {
    site()
    const { defineSiteConfig } = await import('../src/site/config.js')
    const plugin = scopePlugin(await defineSiteConfig())
    expect(plugin).toBeTruthy()
    expect(await plugin.config({}, { command: 'build', mode: 'production' })).toEqual({ define: { __FOUNDATION_SCOPE__: '"@acme"' } })
    expect(await plugin.config({}, { command: 'serve', mode: 'development' })).toEqual({ define: { __FOUNDATION_SCOPE__: 'null' } })
  })

  it('a foundation it loads by URL carries its own, set by that foundation’s build', async () => {
    site()
    process.env.VITE_FOUNDATION_MODE = 'runtime'
    const { defineSiteConfig } = await import('../src/site/config.js')
    expect(scopePlugin(await defineSiteConfig())).toBeUndefined()
  })
})

describe('a working copy — `uniweb dev`', () => {
  it('⭐ a dev rebuild stamps null, and does not read the name', async () => {
    // A `main.js` that does not load: read, it would stop the rebuild.
    const dir = foundation('@acme/marketing')
    writeFileSync(join(dir, 'main.js'), "throw new Error('main.js would not load')\n")
    const plugins = [{ name: DEV_REBUILD_MARKER }, foundationScopeDefine({ foundationDir: dir })]
    expect(await built(dir, { plugins })).toEqual({ own: null, depScope: null })
  })

  it('a dev server hands the browser null, as a global set before any module runs', async () => {
    const dir = foundation('@acme/marketing')
    const server = await createServer({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      plugins: [foundationScopeDefine({ foundationDir: dir })],
      server: { middlewareMode: true },
    })
    try {
      expect(server.config.define.__FOUNDATION_SCOPE__).toBe('null')
      // Vite's client imports its env module first, which sets each define on `globalThis`.
      expect((await server.transformRequest('/@vite/client')).code).toMatch(/^import "[^"]*\/client\/env\.mjs";/m)
      expect((await server.transformRequest('/@vite/env')).code).toContain('{"__FOUNDATION_SCOPE__": null}')
    } finally {
      await server.close()
    }
  })
})
