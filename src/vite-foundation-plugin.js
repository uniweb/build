/**
 * Vite Plugin for Foundation Builds
 *
 * Handles:
 * - Auto-generating entry point from discovered components
 * - Building schema.json from meta files
 * - Processing preview images for presets
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildSchema } from './schema.js'
import { generateEntryPoint, shouldRegenerateForFile } from './generate-entry.js'
import { processAllPreviews } from './images.js'
import { generateFoundationVars } from './theme/index.js'

/**
 * Build schema.json with preview image references
 */
async function buildSchemaWithPreviews(srcDir, outDir, isProduction, sectionPaths) {
  const schema = await buildSchema(srcDir, sectionPaths)

  // Process preview images
  const { schema: schemaWithImages, totalImages } = await processAllPreviews(
    srcDir,
    outDir,
    schema,
    isProduction
  )

  if (totalImages > 0) {
    console.log(`Processed ${totalImages} preview images`)
  }

  return schemaWithImages
}

/**
 * Module-level guard to prevent recursive SSR bundle builds.
 * When buildSSRBundle calls esbuild, it should not re-trigger
 * the foundation plugin's writeBundle hook.
 */
let _buildingSSRBundle = false

/**
 * Emit dist/runtime-pin.json declaring the @uniweb/runtime version this
 * foundation was built against. Read by the edge isolate (under the
 * Strategy S split-bundle path) to decide which runtime/{ver}/ssr.js to
 * side-load from R2.
 *
 * Reads the resolved version from the foundation's node_modules/@uniweb/
 * runtime/package.json so the pin reflects what was actually linked at
 * build time, not what the foundation's own package.json range happens
 * to allow.
 *
 * Silently no-ops when @uniweb/runtime isn't resolvable (e.g., the
 * foundation depends on the runtime via a workspace alias that puts it
 * elsewhere). The edge resolver treats the absence of a pin as the
 * legacy single-bundle path, so omitting the pin is harmless during the
 * dual-mode window.
 *
 * Optional foundation-author override: a `uniweb.runtimePolicy` field
 * in the foundation's own package.json gets recorded alongside the
 * runtime version so the registry's semver resolver can apply it.
 *
 * @param {string} outDir - dist/ directory to write to.
 * @param {string} projectRoot - foundation project root (where package.json lives).
 */
async function emitRuntimePin(outDir, projectRoot) {
  // Resolve @uniweb/runtime via two strategies, in order:
  //   1. createRequire from this plugin's location (catches the runtime
  //      pulled in transitively through @uniweb/build, @uniweb/core, etc.).
  //   2. Walk up node_modules from the project root (catches the case
  //      where the foundation depends on runtime directly).
  // The first covers the common case (foundations don't typically depend
  // on runtime directly — it's the host environment, not a foundation
  // import); the second is a safety net.
  let runtimePkgPath = null

  try {
    // Resolve via an exported subpath, not 'package.json' directly —
    // @uniweb/runtime's `exports` map doesn't include package.json, so
    // require.resolve on it throws ERR_PACKAGE_PATH_NOT_EXPORTED.
    // Walking back from the resolved subpath finds the package root.
    const { createRequire } = await import('node:module')
    const { dirname: pathDirname } = await import('node:path')
    const pluginRequire = createRequire(import.meta.url)
    const ssrEntry = pluginRequire.resolve('@uniweb/runtime/ssr')
    let dir = pathDirname(ssrEntry)
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        const pkg = JSON.parse(await readFile(candidate, 'utf-8'))
        if (pkg.name === '@uniweb/runtime') {
          runtimePkgPath = candidate
          break
        }
      }
      const parent = resolve(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // Fall through to the walk-up search.
  }

  if (!runtimePkgPath) {
    let dir = projectRoot
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'node_modules', '@uniweb', 'runtime', 'package.json')
      if (existsSync(candidate)) {
        runtimePkgPath = candidate
        break
      }
      const parent = resolve(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  }

  if (!runtimePkgPath) {
    // No runtime resolvable. Skip emission — edge will treat as legacy.
    return
  }

  let runtimeVersion
  try {
    const pkg = JSON.parse(await readFile(runtimePkgPath, 'utf-8'))
    runtimeVersion = pkg.version
  } catch {
    return
  }
  if (!runtimeVersion) return

  // Read foundation's own package.json for an optional runtimePolicy
  // field. Default policy (auto-minor) is applied platform-side when
  // the field is omitted; we only record the foundation's override
  // here if explicitly set. See framework/docs/reference/foundation-config.md
  // for the full set of `uniweb.*` fields foundations can declare.
  let policy = null
  try {
    const foundationPkgPath = join(projectRoot, 'package.json')
    if (existsSync(foundationPkgPath)) {
      const foundationPkg = JSON.parse(await readFile(foundationPkgPath, 'utf-8'))
      policy = foundationPkg?.uniweb?.runtimePolicy ?? null
    }
  } catch {
    // Foundation package.json malformed; skip policy. Pin still emits.
  }

  const pin = { runtime: runtimeVersion }
  if (policy) pin.policy = policy

  const pinPath = join(outDir, 'runtime-pin.json')
  await writeFile(pinPath, JSON.stringify(pin, null, 2) + '\n', 'utf-8')
  console.log(`Generated runtime-pin.json (runtime ${runtimeVersion}${policy ? `, policy ${policy}` : ''})`)
}

/**
 * @deprecated 2026-04-27 — Strategy S Phase 2.
 *
 * Foundations no longer carry their own runtime bundle. Runtime + React +
 * core + theming now live in R2 under `runtime/{version}/worker-runtime.js`,
 * published by the platform's `/deploy-runtime` skill, and side-loaded
 * by the Cloudflare isolate alongside `dist/entry.js`.
 *
 * The invocation in `writeBundle()` is commented out; this function
 * definition is kept for the rollout window so it can be flipped back
 * on with one line if Phase 1's edge dispatcher misbehaves in production.
 * Phase 3 cleanup deletes this function entirely once the new path is
 * proven healthy.
 *
 * Original purpose (preserved for context):
 * Build a self-contained ESM bundle for edge SSR (Cloudflare Dynamic Workers).
 * Produces `ssr-worker-bundle.js` — a single ESM file with React,
 * ReactDOM/server, `@uniweb/core`, `@uniweb/runtime/ssr`,
 * `@uniweb/theming`, and the foundation's components all inlined. No
 * external imports. The artifact was bundled this way because the
 * Dynamic Worker LOADER accepts a closed `modules` map at isolate
 * construction. The Phase -1 prototype (2026-04-27) verified the LOADER
 * actually deduplicates shared modules across multiple ESM bundles, so
 * a multi-entry modules map became viable — that's what Strategy S uses.
 *
 * @param {string} outDir - Path to dist/ directory containing entry.js
 */
async function buildSSRBundle(outDir) {
  if (_buildingSSRBundle) return
  _buildingSSRBundle = true

  const entryPath = join(outDir, 'entry.js')
  try {
    const { build: esbuild } = await import('esbuild')
    const { statSync } = await import('node:fs')

    // Collect all node_modules directories up the tree (pnpm hoists to workspace root)
    const { existsSync } = await import('node:fs')
    let searchDir = resolve(outDir, '..')
    let nodePaths = []
    for (let i = 0; i < 10; i++) {
      const candidate = join(searchDir, 'node_modules')
      if (existsSync(candidate)) {
        nodePaths.push(candidate)
      }
      const parent = resolve(searchDir, '..')
      if (parent === searchDir) break
      searchDir = parent
    }

    // Resolve workspace packages that esbuild can't find via node_modules
    // (pnpm workspace symlinks aren't in node_modules for the foundation project)
    const { createRequire } = await import('node:module')
    const pluginRequire = createRequire(import.meta.url)
    let runtimeSSRPath
    try {
      runtimeSSRPath = pluginRequire.resolve('@uniweb/runtime/ssr')
    } catch {
      // Fallback: try to find it relative to the workspace root
      for (const np of nodePaths) {
        const candidate = join(np, '@uniweb', 'runtime', 'dist', 'ssr.js')
        if (existsSync(candidate)) {
          runtimeSSRPath = candidate
          break
        }
      }
    }

    // Build a self-contained ESM bundle including:
    // - Foundation components (from the just-built ESM output)
    // - React + ReactDOM/server (browser version, no Node.js built-ins)
    // - @uniweb/core (Website, Page, Block classes)
    // - @uniweb/runtime/ssr (initPrerender, renderPage, injectPageContent)
    // - @uniweb/theming (buildSectionOverrides, used by runtime/ssr)
    //
    // All in a single file so the Dynamic Worker isolate has one React instance.
    // L2/L3 helpers from @uniweb/runtime/ssr that worker SSR + framework SSG
    // both depend on. Keep this list in sync with runtime/src/ssr-renderer.js
    // exports — missing one here makes the foundation bundle fail to import
    // it ("module does not provide an export named X") inside the SSR isolate.
    const ssrExports = runtimeSSRPath
      ? `export {
          initPrerender, initPrerenderForLocale,
          renderPage, injectPageContent, prefetchIcons,
          sliceContentForLocale, hydrateDataStore,
        } from "${runtimeSSRPath.replace(/\\/g, '/')}";`
      : ''

    // Resolve React to a single package directory to avoid duplicate instances
    // (entry.js and runtime/ssr may resolve to different copies)
    const { dirname } = await import('node:path')
    let reactDir
    try {
      reactDir = dirname(pluginRequire.resolve('react/package.json'))
    } catch {
      // Fall back to nodePaths resolution
    }
    const alias = {}
    if (reactDir) {
      alias['react'] = reactDir
      // Force react-dom/server imports to the browser version (no Node.js built-ins)
      const reactDomDir = dirname(pluginRequire.resolve('react-dom/package.json'))
      alias['react-dom'] = reactDomDir
      alias['react-dom/server'] = join(reactDomDir, 'server.browser.js')
    }

    const foundationPath = entryPath.replace(/\\/g, '/')
    await esbuild({
      stdin: {
        contents: [
          // Foundation components (named + default export)
          `export * from "${foundationPath}";`,
          `export { default } from "${foundationPath}";`,
          // React SSR
          `export { renderToString } from "react-dom/server.browser";`,
          `export { createElement } from "react";`,
          // Runtime SSR functions (initPrerender, renderPage, etc.)
          ssrExports,
        ].join('\n'),
        resolveDir: outDir,
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outfile: join(outDir, 'ssr-worker-bundle.js'),
      minify: false,
      external: [],
      nodePaths,
      alias,
      conditions: ['browser', 'module'],
      logLevel: 'warning',
    })

    const ssrFile = join(outDir, 'ssr-worker-bundle.js')
    const size = (statSync(ssrFile).size / 1024).toFixed(1)
    console.log(`Generated ssr-worker-bundle.js (${size} KB)`)
  } catch (err) {
    console.warn(`Warning: SSR bundle build failed: ${err.message}`)
  } finally {
    _buildingSSRBundle = false
  }
}

/**
 * Append the foundation's theme-variable DEFAULTS as a `:root{}` baseline to the
 * built CSS (`assets/style.css`), so a runtime-loaded foundation carries its own
 * var defaults wherever it loads (registry ref / URL — where the site build can't
 * read them). Context-aware vars (color/gradient) are excluded: those are applied
 * per light/dark context by the site theme, not as a flat default. Idempotent
 * (marker-guarded), and a no-op when the foundation declares no vars or ships no
 * stylesheet to carry them.
 */
async function emitFoundationVarsCss(outDir, schema) {
  const rawVars = schema?._self?.vars
  if (!rawVars || Object.keys(rawVars).length === 0) return

  const CONTEXT_AWARE = new Set(['color', 'gradient'])
  const flatVars = Object.fromEntries(
    Object.entries(rawVars).filter(
      ([, cfg]) => !(cfg && typeof cfg === 'object' && CONTEXT_AWARE.has(cfg.type))
    )
  )

  const rootCss = generateFoundationVars(flatVars)
  if (!rootCss) return

  const cssPath = join(outDir, 'assets', 'style.css')
  if (!existsSync(cssPath)) {
    console.warn(
      `Foundation declares ${Object.keys(flatVars).length} theme var(s) but has no assets/style.css to carry their defaults — skipped.`
    )
    return
  }

  const marker = '/* uniweb:foundation-var-defaults */'
  const existing = await readFile(cssPath, 'utf-8')
  if (existing.includes(marker)) return

  await writeFile(cssPath, `${existing.trimEnd()}\n\n${marker}\n${rootCss}\n`, 'utf-8')
  console.log(`Emitted ${Object.keys(flatVars).length} foundation theme-var default(s) to assets/style.css`)
}

/**
 * Externals for the SSR bundle (`dist/entry-ssr.js`).
 *
 * Same set the browser foundation build externalizes (DEFAULT_EXTERNALS in
 * foundation/config.js — react/react-dom/react-dom-server/jsx-runtime/core),
 * which the Cloudflare edge isolate resolves to the SHARED runtime's React/core
 * (worker-runtime.js) via its shims — so React stays deduped and runtime patches
 * still propagate without a foundation rebuild.
 *
 * PLUS the client-only libraries kit code-splits via dynamic import:
 *   - shiki / shiki/bundle/full — syntax highlighting (kit Code renderer)
 *   - fuse.js                   — client search index
 * Both hydrate in the browser and never run during renderToString (CLAUDE.md
 * gotcha #12). Keeping them external drops the ~10 MB Shiki language graph from
 * the SSR bundle and leaves them as DORMANT dynamic imports the isolate never
 * awaits — so no extra modules-map entry is needed for them edge-side.
 */
const SSR_DEFAULT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/server',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@uniweb/core',
]

function isSSRExternal(id) {
  if (SSR_DEFAULT_EXTERNALS.includes(id)) return true
  if (id === 'shiki' || id.startsWith('shiki/')) return true
  if (id === 'fuse.js' || id.startsWith('fuse.js/')) return true
  return false
}

/**
 * Emit `dist/entry-ssr.js` — the single-file SSR twin of the (code-split)
 * browser `dist/entry.js`.
 *
 * The modern browser `entry.js` is a facade that re-exports from
 * `_entry.generated-*.js` and lazily code-splits kit's client-only features
 * (Shiki, Fuse) into hundreds of chunks — a graph the Cloudflare Dynamic Worker
 * isolate can't resolve (it loads a single `foundation` module). This builds the
 * SAME source entry into ONE file, inlining the foundation's own graph and
 * externalizing the runtime/React set (→ the isolate's shared worker-runtime)
 * and the client-only Shiki/Fuse libs. Result: a ~foundation-sized ESM module
 * (no React, no Shiki) the edge loads as `foundation` for request-time SSR.
 *
 * Built from source (not by re-bundling the built `entry.js`, whose Shiki
 * specifier is already rewritten to a relative chunk path that couldn't be
 * externalized) via a secondary Vite build into a temp dir; only the JS is
 * copied out (the throwaway CSS is discarded — the SSR bundle needs no styles).
 *
 * Best-effort: a failure warns and emits nothing, so the edge simply serves
 * the client-render shell for this foundation (existence-gated) — no regression.
 *
 * @param {string} foundationRoot - foundation project root (vite `root`).
 * @param {string} entrySourcePath - absolute path to `_entry.generated.js`.
 * @param {string} outDir - dist/ directory to write `entry-ssr.js` into.
 */
async function buildEntrySSR(foundationRoot, entrySourcePath, outDir) {
  if (_buildingSSRBundle) return
  _buildingSSRBundle = true

  const { rm, cp, stat } = await import('node:fs/promises')
  const tmpDir = join(outDir, '.entry-ssr-tmp')

  try {
    if (!existsSync(entrySourcePath)) {
      console.warn(`Skipping entry-ssr.js: entry source not found at ${entrySourcePath}`)
      return
    }

    const { build: viteBuild } = await import('vite')

    // Same transform plugins as the browser foundation build (JSX, SVGR, and —
    // best-effort — Tailwind), but WITHOUT foundationPlugin: no schema/entry
    // regeneration and no writeBundle recursion. CSS output is discarded.
    const plugins = []
    try {
      const tailwindcss = (await import('@tailwindcss/vite')).default
      plugins.push(tailwindcss())
    } catch {
      // Tailwind optional / not installed — the SSR bundle discards CSS anyway.
    }
    const react = (await import('@vitejs/plugin-react')).default
    const svgr = (await import('vite-plugin-svgr')).default
    plugins.push(react(), svgr())

    await viteBuild({
      root: foundationRoot,
      configFile: false,
      logLevel: 'warn',
      plugins,
      build: {
        outDir: tmpDir,
        emptyOutDir: true,
        sourcemap: false,
        cssCodeSplit: false,
        lib: {
          entry: entrySourcePath,
          formats: ['es'],
          fileName: () => 'entry-ssr.js',
        },
        rollupOptions: {
          external: isSSRExternal,
          output: { inlineDynamicImports: true },
        },
      },
    })

    const built = join(tmpDir, 'entry-ssr.js')
    if (!existsSync(built)) {
      console.warn('Warning: entry-ssr.js build produced no JS output — skipped.')
      return
    }
    const dest = join(outDir, 'entry-ssr.js')
    await cp(built, dest)
    const size = ((await stat(dest)).size / 1024).toFixed(1)
    console.log(`Generated entry-ssr.js (${size} KB)`)
  } catch (err) {
    console.warn(`Warning: entry-ssr.js build failed: ${err.message}`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    _buildingSSRBundle = false
  }
}

/**
 * Vite plugin for foundation builds
 */
export function foundationBuildPlugin(options = {}) {
  const {
    srcDir = 'src',
    generateEntry = true,
    entryFileName = '_entry.generated.js',
    sections: sectionPaths,
  } = options

  let resolvedSrcDir
  let resolvedOutDir
  let resolvedRoot
  let isProduction

  return {
    name: 'uniweb-foundation-build',

    // Generate entry before config resolution (entry must exist for Vite to resolve it)
    async config(config) {
      if (!generateEntry) return

      const root = config.root || process.cwd()
      const srcPath = resolve(root, srcDir)
      const entryPath = join(srcPath, entryFileName)
      await generateEntryPoint(srcPath, entryPath, { sectionPaths })
    },

    async configResolved(config) {
      resolvedSrcDir = resolve(config.root, srcDir)
      resolvedOutDir = config.build.outDir
      resolvedRoot = config.root
      isProduction = config.mode === 'production'
    },

    async writeBundle() {
      // Skip if this is a recursive call from buildSSRBundle
      if (_buildingSSRBundle) return

      // After bundle is written, generate schema.json in meta folder
      const outDir = resolve(resolvedOutDir)
      const metaDir = join(outDir, 'meta')

      // Ensure meta directory exists
      await mkdir(metaDir, { recursive: true })

      const schema = await buildSchemaWithPreviews(
        resolvedSrcDir,
        outDir,
        isProduction,
        sectionPaths
      )

      const schemaPath = join(metaDir, 'schema.json')
      await writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf-8')

      console.log(`Generated meta/schema.json with ${Object.keys(schema).length - 1} components`)

      // Emit the foundation's theme-variable DEFAULTS as a :root{} baseline into
      // the delivered CSS. A runtime-loaded foundation (registry ref / URL) is
      // loaded with only its dist/ — the site build can't read these defaults
      // (they live in schema._self.vars, which the site never sees), so without
      // this the foundation renders with its theme vars undefined (e.g. collapsed
      // section spacing where components use py-[var(--section-padding-y)]).
      // Shipping the defaults in the foundation's own CSS makes it self-sufficient
      // in every load mode; a site's theme.yml overrides still win (the site theme
      // loads after the foundation CSS). Bundled sites already get these via the
      // site build's theme.css — this is harmless redundancy there.
      await emitFoundationVarsCss(outDir, schema)

      // Emit runtime-pin.json so the edge isolate (under Strategy S) can
      // side-load the matching runtime/{ver}/ssr.js. Lands silently before
      // the dual-mode resolver ships; foundations published in the dual-mode
      // window already have the pin and start using the split-bundle path
      // automatically once the edge is updated.
      await emitRuntimePin(outDir, resolvedRoot)

      // Emit dist/entry-ssr.js — the single-file SSR twin of the (code-split)
      // browser dist/entry.js — for the Cloudflare edge isolate. React + the
      // runtime stay externalized (resolved to the isolate's SHARED
      // worker-runtime, so runtime patches propagate without a rebuild — the
      // Strategy S win); the client-only Shiki/Fuse libs are externalized so the
      // ~10 MB Shiki graph stays out. The edge loads this as its single
      // `foundation` module for request-time SSR, gated on its presence.
      //
      // (The legacy self-contained buildSSRBundle() — React + runtime INLINED,
      // ~14 MB with Shiki — is retained below, unused, for reference only.)
      const entrySourcePath = join(resolvedSrcDir, entryFileName)
      await buildEntrySSR(resolvedRoot, entrySourcePath, outDir)
    },

    async closeBundle() {
      // esbuild spawns a long-lived service child process on first build() and
      // keeps it running. Its stop() is the documented teardown for hosts that
      // need to exit cleanly. Best-effort — never fail the build over this.
      try {
        const { stop } = await import('esbuild')
        await stop?.()
      } catch {}
    },
  }
}

/**
 * Vite plugin for development mode
 * Watches meta files and regenerates entry on change
 */
export function foundationDevPlugin(options = {}) {
  const {
    srcDir = 'src',
    entryFileName = '_entry.generated.js',
    sections: sectionPaths,
  } = options

  let resolvedSrcDir

  return {
    name: 'uniweb-foundation-dev',

    // Generate entry before config resolution
    async config(config) {
      const root = config.root || process.cwd()
      const srcPath = resolve(root, srcDir)
      const entryPath = join(srcPath, entryFileName)
      await generateEntryPoint(srcPath, entryPath, { sectionPaths })
    },

    configResolved(config) {
      resolvedSrcDir = resolve(config.root, srcDir)
    },

    async handleHotUpdate({ file, server }) {
      const reason = shouldRegenerateForFile(file, resolvedSrcDir)
      if (reason) {
        console.log(`[foundation] ${reason}, regenerating entry...`)
        const entryPath = join(resolvedSrcDir, entryFileName)
        await generateEntryPoint(resolvedSrcDir, entryPath, { sectionPaths })
        server.ws.send({ type: 'full-reload' })
      }
    },
  }
}

/**
 * Combined plugin that works for both dev and build
 */
export function foundationPlugin(options = {}) {
  const buildPlugin = foundationBuildPlugin(options)
  const devPlugin = foundationDevPlugin(options)

  return {
    name: 'uniweb-foundation',

    async config(config) {
      // Only need to call once - devPlugin.config generates the entry
      await devPlugin.config?.(config)
    },

    configResolved(config) {
      buildPlugin.configResolved?.(config)
      devPlugin.configResolved?.(config)
    },

    async writeBundle(...args) {
      await buildPlugin.writeBundle?.(...args)
    },

    handleHotUpdate(...args) {
      return devPlugin.handleHotUpdate?.(...args)
    },
  }
}

export default foundationPlugin
