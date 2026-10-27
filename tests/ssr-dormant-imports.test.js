/**
 * A package a foundation imports dynamically stays dormant in its single-file SSR twin.
 *
 * `entry-ssr.js` folds every dynamic import into one file, and a module folded in runs when the
 * file loads. A client-only library loaded in an effect — Leaflet, for a map — then ran in the
 * host's isolate at load, threw on `window`, and the foundation never loaded: every page was
 * served as the bare shell (measured on a published site, 2026-10-27). These builds use the
 * options `buildEntrySSR` does.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { ssrDormantDynamicImports, isPackageSpecifier } from '../src/foundation/ssr-dormant-imports.js'

describe('isPackageSpecifier', () => {
  it.each(['leaflet', '@uniweb/projections/search/engine', 'shiki/core', 'chart.js'])('%s is a package', (s) => {
    expect(isPackageSpecifier(s)).toBe(true)
  })
  it.each(['./chart.js', '../lib/x.js', '/abs/x.js', '#components/Map', '\0virtual', 'virtual:entry', 'https://cdn.example/x.js', 'node:fs', ''])(
    '%s is not',
    (s) => {
      expect(isPackageSpecifier(s)).toBe(false)
    }
  )
})

describe('the SSR twin of a foundation that loads a browser-only package on demand', () => {
  let root

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'uniweb-ssr-dormant-'))
    // A package that, like Leaflet, needs a browser the moment it is evaluated.
    await mkdir(join(root, 'node_modules', 'browser-only'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'browser-only', 'package.json'), JSON.stringify({ name: 'browser-only', type: 'module', main: 'index.js' }))
    await writeFile(join(root, 'node_modules', 'browser-only', 'index.js'), 'window.browserOnly = true\nexport default "loaded"\n')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'own.js'), 'export const own = "the foundation’s own module"\n')
    await writeFile(
      join(root, 'entry.js'),
      'export const loadLibrary = () => import("browser-only")\nexport const loadOwn = () => import("./src/own.js")\n'
    )
  })
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  async function twin(outDir, plugins) {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins,
      build: {
        outDir: join(root, outDir),
        emptyOutDir: true,
        lib: { entry: join(root, 'entry.js'), formats: ['es'], fileName: () => 'entry-ssr.js' },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
    const file = join(root, outDir, 'entry-ssr.js')
    return { file, code: await readFile(file, 'utf8') }
  }

  it('⭐ keeps the package as a dynamic import, folds in the foundation’s own, and loads with no window', async () => {
    const { file, code } = await twin('dist', [ssrDormantDynamicImports()])
    expect(code).toMatch(/import\(\s*["']browser-only["']\s*\)/)
    expect(code).not.toContain('window.browserOnly')
    expect(code).toContain('the foundation’s own module')
    // Node has no `window`, like an isolate: evaluating the twin must not reach for one.
    const loaded = await import(pathToFileURL(file).href)
    expect(typeof loaded.loadLibrary).toBe('function')
    expect((await loaded.loadOwn()).own).toBe('the foundation’s own module')
  })

  it('CONTROL — folded in, the package runs at load and the twin cannot be loaded without a browser', async () => {
    const { file, code } = await twin('dist-folded', [])
    expect(code).toContain('window.browserOnly')
    await expect(import(pathToFileURL(file).href)).rejects.toThrow(/window is not defined/)
  })
})
