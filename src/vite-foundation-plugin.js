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
import { DEFAULT_EXTERNALS } from './import-map-plugin.js'
import { deriveSupports } from './foundation/derive-supports.js'
import { proseWithoutStyles, PROSE_WITHOUT_STYLES_WARNING } from './foundation/prose-styles.js'

// Foundations already told that their prose has no stylesheet — once per process, so a dev
// server's rebuild on every save does not repeat it.
const warnedProseWithoutStyles = new Set()

/**
 * Build schema.json with preview image references
 */
async function buildSchemaWithPreviews(srcDir, outDir, isProduction, sectionPaths, derivedSupports) {
  const schema = await buildSchema(srcDir, sectionPaths, derivedSupports)

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
 * Module-level guard around the `entry-ssr.js` sub-build (buildEntrySSR): while
 * it runs, the foundation plugin's writeBundle hook does nothing.
 */
let _buildingSSRBundle = false

/**
 * Emit dist/runtime-pin.json declaring the @uniweb/runtime version this
 * foundation was built against.
 *
 * ⛔ **NOTHING ENFORCES IT.** `uniweb register` reads the pin and carries it
 * with the foundation (as `info.runtime`), so the floor reaches a party that
 * could act on it — but no lane checks it yet. This header previously said a
 * server-side isolate read the pin to pick which runtime to side-load, and that
 * a "semver resolver" applied the policy. Neither existed, and for a while the
 * pin was written and read by nothing at all. The wrong version had reached
 * four documentation surfaces before anyone checked it against the consumers,
 * which is the cost of describing a design as though it had shipped.
 *
 * The pin is a **compatibility floor**, not a selector, and it cannot be a
 * selector: a site loads a primary foundation plus N extensions, each emitting
 * its own pin, while a site has exactly one runtime — pins are plural, the
 * choice is singular. The pin's use is VALIDATION — is a site's runtime at or
 * above max() of every loaded foundation's floor? — which belongs wherever all
 * of those foundations are held, not here: this build sees one foundation.
 *
 * ⚠️ **This used to say "the selector is `site.yml::runtime`". It is not.** That
 * key is an operator-level override, not the authoring surface: a link-mode site
 * is CODELESS, so it has nothing that binds to a runtime version and no basis for
 * an opinion about one. The selector is whatever serves the site. What a
 * foundation declares here is the CONSTRAINT on that choice, never the choice.
 *
 * Reads the resolved version from the foundation's node_modules/@uniweb/
 * runtime/package.json so the pin reflects what was actually linked at
 * build time, not what the foundation's own package.json range happens
 * to allow.
 *
 * Silently no-ops when @uniweb/runtime isn't resolvable (e.g., the
 * foundation depends on the runtime via a workspace alias that puts it
 * elsewhere). Nothing breaks without it — but note the absence means the
 * foundation states NO floor, and "unknown" is not "unconstrained": a floor
 * nobody declared cannot be shown to be satisfied.
 *
 * Optional foundation-author override: a `uniweb.runtimePolicy` field in the
 * foundation's own package.json is recorded alongside the runtime version,
 * declaring the author's intent for the validation above.
 *
 * ⛔ **`policy` IS NOT SENT AT REGISTER — this half is ours and is certain.**
 * `readRuntimePin()` (`cli/src/utils/code-upload.js`) returns only `.runtime`, so
 * `register` carries the floor as `info.runtime` and the policy is dropped. A
 * foundation author who sets `uniweb.runtimePolicy` gets it emitted into `dist/`
 * and no further.
 *
 * ⚠️ **Whether a HOST reads `runtime-pin.json` off the built foundation is that
 * host's to answer, not ours — name the host before saying what is consumed.**
 * A note here once read "nothing consumes it today", unscoped, which is a claim
 * about every host the framework serves and framework can substantiate it for
 * none of them.
 *
 * 📌 **The check, so this is not a claim with no expiry:** grep a host's serving
 * code for `runtime-pin` / `runtimePolicy`. An answer is about one host on one
 * date; a static host or a foreign backend is a separate question.
 *
 * ⚖️ **This is a field with standing and no consumer — NOT a mistake to delete.**
 * The architecture assigns this declaration to the foundation on principle: each
 * version policy is declared by the party whose code binds to the thing being
 * updated, and the foundation's JS is what links against the runtime's React and
 * core. So this is the designated home for the answer; nothing has asked for the
 * answer yet.
 *
 * ⇒ **The event that gives it a consumer:**
 * when the runtime declares what it supplies — replacing today's `>=` version
 * compare, which is a proxy that holds only while the runtime's version number
 * tracks its externals contract — **or** when the publish path starts consulting
 * floors at all, whichever lands first. Ask again then; until one of those, delivering
 * `policy` would add a field compared against a number already known to be a
 * stand-in. **Do not wire it, and do not remove it, without re-opening that.**
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
    // No runtime resolvable. Skip emission — the foundation then states no
    // floor (see the header).
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
  // field, recorded only when explicitly set. What a host does when it is
  // omitted is that host's to say (see the header). See
  // framework/docs/reference/foundation-config.md for the full set of
  // `uniweb.*` fields foundations can declare.
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
  // Said HERE, not only in the header above: this line is where a foundation
  // author meets the field, and reading "policy X" next to a floor that IS
  // delivered implies both travel. Only the floor does.
  if (policy) {
    console.log(
      `  note: runtimePolicy "${policy}" is recorded in dist/runtime-pin.json and is NOT sent at register.\n` +
        `        The floor (runtime ${runtimeVersion}) does travel, as info.runtime.\n` +
        `        Whether your host reads the file is its own to say — see the header for how to check.`
    )
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
 * Same set the browser foundation build externalizes, and now literally the
 * same array — `DEFAULT_EXTERNALS`, imported rather than re-typed. A host
 * rendering the SSR bundle resolves these to the runtime's shared React/core,
 * so React stays deduped and runtime patches still propagate without a
 * foundation rebuild. "Same set" was a comment three copies made a promise
 * rather than a fact; deriving it makes drift unrepresentable.
 *
 * PLUS the client-only library kit code-splits via dynamic import:
 *   - shiki / shiki/bundle/full — syntax highlighting (kit Code renderer)
 * It hydrates in the browser and never runs during renderToString. Keeping it
 * external drops the ~10 MB Shiki language graph from the SSR bundle and leaves
 * it a DORMANT dynamic import that server rendering never awaits — so a host
 * has nothing to supply for it.
 *
 * ⛔ `fuse.js` was listed here too, until the local search ranker became
 * `@uniweb/projections/search` (2026-09-06). Nothing imports fuse now, so the
 * entry matched no id and was removed rather than left as a claim that it is
 * still in play. The projections engine needs no entry: it is a leaf of a
 * package already in the graph, not a third-party dependency.
 */
const SSR_DEFAULT_EXTERNALS = DEFAULT_EXTERNALS

function isSSRExternal(id) {
  if (SSR_DEFAULT_EXTERNALS.includes(id)) return true
  if (id === 'shiki' || id.startsWith('shiki/')) return true
  return false
}

/**
 * Emit `dist/entry-ssr.js` — the single-file SSR twin of the (code-split)
 * browser `dist/entry.js`.
 *
 * The modern browser `entry.js` is a facade that re-exports from
 * `_entry.generated-*.js` and lazily code-splits kit's client-only features
 * (Shiki) into hundreds of chunks — a graph that a request-time renderer loading
 * the foundation as a single module can't resolve. This builds the SAME source
 * entry into ONE file, inlining the foundation's own graph and externalizing the
 * runtime/React set (→ the runtime's shared build) and the client-only Shiki
 * lib. Result: a ~foundation-sized ESM module (no React, no Shiki) that a host
 * can load for request-time SSR.
 *
 * Built from source (not by re-bundling the built `entry.js`, whose Shiki
 * specifier is already rewritten to a relative chunk path that couldn't be
 * externalized) via a secondary Vite build into a temp dir; only the JS is
 * copied out (the throwaway CSS is discarded — the SSR bundle needs no styles).
 *
 * Best-effort: a failure warns and emits nothing. The browser `entry.js` is
 * unaffected, so the foundation still renders client-side.
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
 * Marks a foundation build as a DEV-server rebuild.
 *
 * The dev server runs a real Vite `build()` of the foundation on every watched
 * change (`dev/plugin.js`), so `command`, `mode` and `isProduction` cannot tell
 * a dev rebuild from a shipping build — all of them say "build". An injected
 * marker plugin can, and it survives the foundation's own `vite.config.js`
 * being merged in, which a plugin *option* would not (the dev server does not
 * construct the foundation plugin — the foundation's config file does).
 *
 * Used to skip the `entry-ssr.js` sub-build in dev: it is a second full Vite
 * pass per save, and nothing in the dev loop reads it (dev never ships, and the
 * SSR lanes that run locally — SSG prerender and unipress — load `entry.js`).
 */
export const DEV_REBUILD_MARKER = 'uniweb:dev-foundation-rebuild'

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
  let isDevRebuild = false

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
      isDevRebuild = (config.plugins || []).some((p) => p?.name === DEV_REBUILD_MARKER)
    },

    async writeBundle(_options, bundle) {
      // Skip while the entry-ssr.js sub-build (buildEntrySSR) is running
      if (_buildingSSRBundle) return

      // kit's <Prose> / <Article> with no prose styles in the CSS: correct markup, unstyled page,
      // and nothing else says so (`foundation/prose-styles.js`). Dev rebuilds included — that is
      // where a developer sees it first.
      if (!warnedProseWithoutStyles.has(resolvedSrcDir) && proseWithoutStyles(bundle)) {
        warnedProseWithoutStyles.add(resolvedSrcDir)
        console.warn(PROSE_WITHOUT_STYLES_WARNING)
      }

      // What host services this foundation actually reaches for, read off the
      // post-tree-shake module graph rather than asked for in package.json.
      //
      // ⛔ GATED ON `isDevRebuild`, NOT ON `isProduction` — the dev server runs
      // a real Vite build() of the foundation on every watched change, so
      // `command`, `mode` and `isProduction` all say "build" and cannot tell a
      // save from a shipping build (see DEV_REBUILD_MARKER). Same gate, and the
      // same reason, as the entry-ssr.js sub-build below: nothing in the dev
      // loop reads this, because `supports` is register-time metadata and dev
      // never registers. `register`'s build-if-stale check treats a dist left
      // by a dev session as stale, so this can never ship underived.
      const derivedSupports = isDevRebuild ? null : deriveSupports(bundle, this)

      // After bundle is written, generate schema.json in meta folder
      const outDir = resolve(resolvedOutDir)
      const metaDir = join(outDir, 'meta')

      // Ensure meta directory exists
      await mkdir(metaDir, { recursive: true })

      const schema = await buildSchemaWithPreviews(
        resolvedSrcDir,
        outDir,
        isProduction,
        sectionPaths,
        derivedSupports
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

      // Record which @uniweb/runtime this build linked against: a compatibility
      // floor that `register` carries as `info.runtime` and that nothing in the
      // framework enforces — see emitRuntimePin's header before assuming more.
      await emitRuntimePin(outDir, resolvedRoot)

      // Emit dist/entry-ssr.js — the single-file SSR twin of the (code-split)
      // browser dist/entry.js — for a host that renders at request time. React
      // + the runtime stay externalized (resolved to the runtime's shared build,
      // so runtime patches propagate without a foundation rebuild); the
      // client-only Shiki lib is externalized so the ~10 MB Shiki graph stays
      // out.
      //
      // Skipped on a DEV rebuild: this is a second full Vite pass, it runs on
      // every save, and nothing in the dev loop reads its output. The local SSR
      // lanes load `entry.js` (SSG prerender via `import()`, unipress the same);
      // only a request-time host needs the single-file twin, and dev ships
      // nothing to one.
      //
      // Shipping lanes are unaffected — `uniweb build`, and `register`/`publish`
      // which build through it. `register`'s build-if-stale check also requires
      // `entry-ssr.js`, so a dist left behind by a dev session is treated as
      // stale and rebuilt rather than uploaded without one.
      if (!isDevRebuild) {
        const entrySourcePath = join(resolvedSrcDir, entryFileName)
        await buildEntrySSR(resolvedRoot, entrySourcePath, outDir)
      }
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

    // ⛔ `.call(this, …)`, not `buildPlugin.writeBundle(…)`. The inner hook reads
    // the Rollup plugin context (`this.getModuleInfo`) to derive
    // `uniweb.supports` from the module graph, and a plain method call would
    // bind `this` to `buildPlugin` instead. Nothing would throw: the context
    // probe is optional-chained, so the derivation would silently return an
    // empty set and every foundation would publish nothing.
    async writeBundle(...args) {
      await buildPlugin.writeBundle?.call(this, ...args)
    },

    handleHotUpdate(...args) {
      return devPlugin.handleHotUpdate?.(...args)
    },
  }
}

export default foundationPlugin
