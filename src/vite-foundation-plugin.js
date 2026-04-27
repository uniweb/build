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
 * side-load from R2. See kb/platform/plans/edge-ssr-bundling-strategy.md
 * and kb/platform/operations/release-workflow.md.
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
  // field. Default policy (auto-patch) lives at the registry layer; we
  // only record the foundation's override if explicitly set.
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
 * Build a self-contained ESM bundle for edge SSR (Cloudflare Dynamic Workers).
 *
 * Produces `ssr-worker-bundle.js` — a single ESM file with React,
 * ReactDOM/server, `@uniweb/core`, `@uniweb/runtime/ssr`,
 * `@uniweb/theming`, and the foundation's components all inlined. No
 * external imports.
 *
 * This is **NOT a foundation**. The foundation is `dist/foundation.js`
 * — a foundation-shaped ESM module that externalizes runtime and links
 * to it at runtime, the same as in browser SPA / framework SSG / unipress
 * (Node SSR). This file is something different: a self-contained SSR
 * pipeline shaped for the Cloudflare Workers Dynamic Worker LOADER, with
 * the foundation embedded as one of several inputs. The size ratio
 * (typical ~12× larger than `foundation.js`) reflects what's actually
 * inside it.
 *
 * The artifact is bundled this way because the Dynamic Worker LOADER
 * accepts a closed `modules` map at isolate construction (no external
 * resolver, no path back to npm or R2 for transitive imports). One
 * file in, everything resolves. A future refactor can switch to side-
 * loading runtime + React + core into the modules map separately so
 * foundations stop carrying runtime in their bundles — see
 * `kb/platform/plans/edge-ssr-bundling-strategy.md`. Until then, this
 * build pre-bundles for the isolate's contract.
 *
 * @param {string} outDir - Path to dist/ directory containing foundation.js
 */
async function buildSSRBundle(outDir) {
  if (_buildingSSRBundle) return
  _buildingSSRBundle = true

  const entryPath = join(outDir, 'foundation.js')
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
    // (foundation.js and runtime/ssr may resolve to different copies)
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

      // Emit runtime-pin.json so the edge isolate (under Strategy S) can
      // side-load the matching runtime/{ver}/ssr.js. Lands silently before
      // the dual-mode resolver ships; foundations published in the dual-mode
      // window already have the pin and start using the split-bundle path
      // automatically once the edge is updated.
      await emitRuntimePin(outDir, resolvedRoot)

      // Build self-contained SSR bundle for edge rendering (Dynamic Workers).
      // Stays in the build until Strategy S Phase 2 — dual-mode edge
      // resolver continues to fall back to it for foundations without
      // a runtime pin.
      await buildSSRBundle(outDir)
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
