/**
 * Site Vite Configuration
 *
 * Provides a zero-config or minimal-config Vite setup for Uniweb sites.
 * Reads configuration from site.yml and sets up all necessary plugins.
 *
 * @module @uniweb/build/site/config
 *
 * @example
 * // Minimal vite.config.js (recommended)
 * export { default } from '@uniweb/build/site/config'
 *
 * @example
 * // With customization
 * import { defineSiteConfig } from '@uniweb/build/site'
 *
 * export default defineSiteConfig({
 *   server: { port: 4000 },
 *   plugins: [myCustomPlugin()],
 * })
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import yaml from 'js-yaml'
import {
  generateEntryPoint,
  shouldRegenerateForFile,
  getStructuralWatchPaths
} from '../generate-entry.js'
import { importMapPlugin } from '../import-map-plugin.js'
import { resolveModuleUrl, resolveExtensionUrls } from './extension-urls.js'
import { resolveFoundationSrcPath } from '../utils/foundation-source-root.js'
import { detectFoundationType } from './foundation-ref.js'

/**
 * Normalize a base path for Vite compatibility
 *
 * Handles common user mistakes:
 * - Missing leading slash: "docs/" → "/docs/"
 * - Missing trailing slash: "/docs" → "/docs/"
 * - Extra slashes: "//docs///" → "/docs/"
 * - Just a slash: "/" → undefined (root, no base needed)
 *
 * @param {string} raw - Raw base path from site.yml, env, or option
 * @returns {string|undefined} Normalized path with leading+trailing slash, or undefined for root
 */
function normalizeBasePath(raw) {
  // Collapse repeated slashes and trim whitespace
  let path = raw.trim().replace(/\/{2,}/g, '/')

  // Ensure leading slash
  if (!path.startsWith('/')) path = '/' + path

  // Ensure trailing slash (Vite requirement)
  if (!path.endsWith('/')) path = path + '/'

  // Root path means no base needed
  if (path === '/') return undefined

  return path
}

// `detectFoundationType` moved to its own leaf so lanes that must not pull Vite
// can resolve a foundation declaration too — see that file's header. Imported as
// well as re-exported: this module calls it, and a bare re-export creates no local
// binding.
export { detectFoundationType }

/**
 * Read and parse site.yml configuration
 *
 * @param {string} siteRoot - Path to site directory
 * @returns {Object}
 */
export function readSiteConfig(siteRoot) {
  const configPath = resolve(siteRoot, 'site.yml')
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    return yaml.load(readFileSync(configPath, 'utf8')) || {}
  } catch (err) {
    console.warn('[site-config] Failed to read site.yml:', err.message)
    return {}
  }
}

/**
 * Create a complete Vite configuration for a Uniweb site
 *
 * @param {Object} [options={}] - Configuration overrides
 * @param {Object} [options.server] - Vite server options
 * @param {Array} [options.plugins] - Additional Vite plugins
 * @param {Object} [options.build] - Vite build options
 * @param {Object} [options.resolve] - Vite resolve options
 * @param {Object} [options.seo] - SEO configuration for siteContentPlugin
 * @param {Object} [options.assets] - Asset processing configuration
 * @param {Object} [options.search] - Search index configuration
 * @param {boolean} [options.tailwind] - Include Tailwind CSS v4 Vite plugin (default: true)
 * @param {string} [options.base] - Base public path for deployment (e.g., '/demos/mysite/')
 * @returns {Promise<Object>} Vite configuration
 */
/** De-duplicate a list, keeping first-seen order. */
function unique(list) {
  return [...new Set(list)]
}

export async function defineSiteConfig(options = {}) {
  const {
    plugins: extraPlugins = [],
    server: serverOverrides = {},
    build: buildOverrides = {},
    resolve: resolveOverrides = {},
    optimizeDeps: optimizeDepsOverrides = {},
    seo = {},
    assets = {},
    search = {},
    tailwind = true,
    base: baseOption,
    ...restOptions
  } = options

  // Determine site root (where vite.config.js is)
  const siteRoot = process.cwd()

  // Read site.yml
  const siteConfig = readSiteConfig(siteRoot)

  // `site.yml` is the only place a site's foundation is declared. A
  // `UNIWEB_FOUNDATION_REF` env override lived here until 2026-08-04, silently
  // substituting a different foundation for the duration of a build. It served
  // the `uniweb deploy` auto-publish flow, which was removed; after that no
  // command set it, so what remained was an invisible way for a site to be
  // rendered by code its own config did not name. Removed rather than kept as a
  // manual escape hatch — which foundation renders a site is exactly the thing
  // that should never be true-but-unstated.

  // Determine base path for deployment (priority: option > env > site.yml)
  // Normalize: ensure leading slash, collapse repeated slashes, add trailing slash for Vite
  const rawBase = baseOption || process.env.UNIWEB_BASE || siteConfig.base
  const base = rawBase ? normalizeBasePath(String(rawBase)) : undefined

  // Detect foundation type
  const foundationInfo = detectFoundationType(siteConfig.foundation, siteRoot)

  // Check for runtime mode (env variable or URL-based foundation).
  // Runtime mode means the foundation is loaded by URL at runtime; the
  // site bundles only the runtime SPA + import-map bridges, not the
  // foundation itself.
  const isRuntimeMode =
    process.env.VITE_FOUNDATION_MODE === 'runtime' || foundationInfo.type === 'url'

  // Extensions are always runtime-loaded via import(), so they need import maps
  // to resolve bare specifiers (react, @uniweb/core) even in bundled mode
  const hasExtensions = siteConfig.extensions?.length > 0
  const needsImportMap = isRuntimeMode || hasExtensions

  // Dynamic imports for optional peer dependencies
  // These are imported dynamically to avoid requiring them when not needed
  const imports = [
    import('@vitejs/plugin-react'),
    import('vite-plugin-svgr'),
    import('./plugin.js'),
    import('../dev/plugin.js')
  ]

  // Only import Tailwind v4 Vite plugin if enabled
  if (tailwind) {
    imports.unshift(import('@tailwindcss/vite'))
  }

  const modules = await Promise.all(imports)

  // Extract plugins based on what was imported
  let tailwindcss, react, svgr, siteContentPlugin, foundationDevPlugin
  if (tailwind) {
    tailwindcss = modules[0].default
    react = modules[1].default
    svgr = modules[2].default
    siteContentPlugin = modules[3].siteContentPlugin
    foundationDevPlugin = modules[4].foundationDevPlugin
  } else {
    react = modules[0].default
    svgr = modules[1].default
    siteContentPlugin = modules[2].siteContentPlugin
    foundationDevPlugin = modules[3].foundationDevPlugin
  }

  // Plugin to ensure foundation entry file exists (for bundled mode with local foundation)
  const ensureFoundationEntryPlugin = !isRuntimeMode && foundationInfo.type === 'local' ? {
    name: 'uniweb:ensure-foundation-entry',
    async config() {
      const srcDir = resolveFoundationSrcPath(foundationInfo.path)
      const entryPath = join(srcDir, '_entry.generated.js')

      // Always regenerate on dev start to ensure it's current
      // This handles new components being added
      if (existsSync(srcDir)) {
        console.log('[site] Ensuring foundation entry is up to date...')
        try {
          await generateEntryPoint(srcDir, entryPath)
        } catch (err) {
          console.warn('[site] Failed to generate foundation entry:', err.message)
        }
      }
    },

    configureServer(server) {
      // Watch foundation src for structural changes that affect the entry.
      // Add the structural paths individually rather than the source root:
      // under the flat layout that root is the foundation *package* root, so
      // adding it walks node_modules/, dist/ and .git/. Vite's default ignore
      // list filters those out today, but there is no reason to hand a package
      // root to a watcher and depend on the filter to undo it.
      const srcDir = resolveFoundationSrcPath(foundationInfo.path)
      const entryPath = join(srcDir, '_entry.generated.js')

      server.watcher.add(getStructuralWatchPaths(srcDir))

      server.watcher.on('all', async (event, path) => {
        const reason = shouldRegenerateForFile(path, srcDir)
        if (reason) {
          console.log(`[site] Foundation ${reason}, regenerating entry...`)
          try {
            await generateEntryPoint(srcDir, entryPath)
            server.ws.send({ type: 'full-reload' })
          } catch (err) {
            console.warn('[site] Failed to regenerate foundation entry:', err.message)
          }
        }
      })
    }
  } : null

  // Build the plugins array
  const plugins = [
    // Ensure foundation entry exists first (bundled mode only)
    ensureFoundationEntryPlugin,

    // Standard plugins
    tailwind && tailwindcss(),
    react(),
    svgr(),

    // Site content collection and injection
    siteContentPlugin({
      sitePath: './',
      seo,
      assets,
      search,
      foundationPath: foundationInfo.path // For loading foundation theme vars
    }),

    // Foundation dev server (only in runtime mode with local foundation)
    isRuntimeMode &&
      foundationInfo.type === 'local' &&
      foundationDevPlugin({
        name: foundationInfo.name,
        path: foundationInfo.path,
        serve: '/foundation',
        watch: true
      }),

    // User-provided plugins
    ...extraPlugins
  ].filter(Boolean)

  // Build resolve.alias configuration
  const alias = {}

  if (isRuntimeMode) {
    // In runtime mode, foundation is loaded via URL at runtime.
    // main.js still imports #foundation so Vite can resolve it,
    // but start() ignores the import and uses the URL instead.
    // Point #foundation at a virtual noop module.
    alias['#foundation'] = '\0__foundation-noop__'
  } else if (foundationInfo.type !== 'url') {
    // Bundled mode: #foundation points to the actual package
    alias['#foundation'] = foundationInfo.name
  }

  // Virtual module plugin for the noop foundation stub
  const noopFoundationPlugin = isRuntimeMode ? {
    name: 'uniweb:foundation-noop',
    resolveId(id) {
      if (id === '\0__foundation-noop__' || id.startsWith('\0__foundation-noop__')) return id
    },
    load(id) {
      if (id === '\0__foundation-noop__') return 'export default {}'
      // Handle #foundation/styles → noop CSS
      if (id.startsWith('\0__foundation-noop__')) return ''
    }
  } : null

  if (noopFoundationPlugin) plugins.push(noopFoundationPlugin)

  // Import map plugin for runtime mode production builds.
  // Emits re-export modules for each externalized package (react, @uniweb/core, etc.)
  // so the browser can resolve bare specifiers in the dynamically-imported foundation.
  // In dev mode, Vite's transformRequest() handles bare specifier resolution instead.
  if (needsImportMap) {
    plugins.push(importMapPlugin({
      basePath: base || '/',
      // Under pnpm strict mode, the site may not have @uniweb/core in its own
      // node_modules. Resolve from the foundation directory where it's a direct dep.
      resolveFrom: foundationInfo.path
        ? resolve(foundationInfo.path, 'package.json')
        : resolve(siteRoot, 'main.js'),
    }))
  }

  // Preload hints for runtime-loaded foundations and extensions.
  // In runtime mode, foundation JS is loaded via import() and CSS is injected
  // dynamically in JavaScript — the browser doesn't discover them until JS executes.
  // These <link> tags let the browser start fetching during HTML parsing.
  if (isRuntimeMode) {
    plugins.push({
      name: 'uniweb:foundation-preload',
      transformIndexHtml: {
        order: 'post',
        handler() {
          const tags = []

          // Foundation JS modulepreload
          if (foundationConfig.url) {
            tags.push({
              tag: 'link',
              attrs: { rel: 'modulepreload', href: foundationConfig.url },
              injectTo: 'head',
            })
          }

          // Foundation CSS — injected as a real <link> so the browser fetches it
          // during HTML parsing instead of waiting for loadFoundationCSS() in JS.
          // The runtime's dynamic <link> deduplicates (same URL, already cached).
          if (foundationConfig.cssUrl) {
            tags.push({
              tag: 'link',
              attrs: { rel: 'stylesheet', href: foundationConfig.cssUrl },
              injectTo: 'head',
            })
          }

          // Extension JS modulepreload (CSS left to runtime — we can't reliably
          // derive CSS URLs for all extension formats).
          //
          // Resolved through the SAME helper the payload uses, so the hint and
          // `config.extensions` cannot disagree. They did: the payload was
          // base-resolved at load time by the runtime while this emitted the
          // raw URL, so on a subdirectory deploy the browser preloaded one URL
          // and then requested another.
          const extensions = resolveExtensionUrls(siteConfig.extensions, base) || []
          for (const ext of extensions) {
            const url = typeof ext === 'string' ? ext : ext?.url
            if (url) {
              tags.push({
                tag: 'link',
                attrs: { rel: 'modulepreload', href: url },
                injectTo: 'head',
              })
            }
          }

          return tags
        },
      },
    })
  }

  // Build foundation config for runtime.
  //
  // URLs are resolved against the deployment base HERE, because what reaches
  // the runtime is final — the loader anchors a root-relative URL to the
  // document origin and applies no base of its own. That is what makes the
  // primary foundation and every extension follow one rule; they used to
  // differ. See site/extension-urls.js.
  const foundationConfig = resolveModuleUrl({
    mode: isRuntimeMode ? 'runtime' : 'bundled',
    url: foundationInfo.url || '/foundation/foundation.js',
    cssUrl: foundationInfo.cssUrl || '/foundation/assets/style.css'
  }, base)

  return {
    // Base public path for deployment (e.g., '/demos/mysite/')
    // Vite uses this to prefix all asset URLs and sets import.meta.env.BASE_URL
    ...(base && { base }),

    plugins,

    define: {
      __FOUNDATION_CONFIG__: JSON.stringify(foundationConfig)
    },

    resolve: {
      // Deduplicate React packages to prevent dual-instance issues
      // Foundation externalizes React; when site bundles it, CJS and ESM
      // copies can coexist without this, causing "useRef of null" errors
      dedupe: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      alias: {
        ...alias,
        ...resolveOverrides?.alias
      }
    },

    server: {
      fs: {
        // Allow parent directory for foundation sibling access
        // Plus any external content paths from site.yml paths: group
        allow: (() => {
          const allowed = ['..']
          const parentDir = resolve(siteRoot, '..')
          const paths = siteConfig.paths || {}
          for (const key of ['pages', 'layout', 'entities']) {
            if (paths[key]) {
              const resolved = resolve(siteRoot, paths[key])
              if (!resolved.startsWith(parentDir)) {
                allowed.push(resolved)
              }
            }
          }
          return allowed
        })()
      },
      ...(siteConfig.build?.port && { port: siteConfig.build.port }),
      ...serverOverrides
    },

    build: {
      ...buildOverrides
    },

    // `include` and `exclude` are unioned with anything the site adds rather
    // than replaced by it. Every other key here is a value a caller can
    // reasonably want to override outright; these two are lists of things that
    // must be true, and the framework's entries are load-bearing — React has to
    // be prebundled or the site gets two copies of it. A site adding one
    // package to `exclude` is asking for one more exclusion, not volunteering
    // to restate the framework's list, and getting that wrong is silent: the
    // dev server starts, and the failure surfaces somewhere unrelated.
    optimizeDeps: {
      ...optimizeDepsOverrides,
      include: unique([
        'react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-router-dom',
        ...(optimizeDepsOverrides.include || [])
      ]),
      exclude: unique(['#foundation', ...(optimizeDepsOverrides.exclude || [])])
    },

    ...restOptions
  }
}

/**
 * Default export - an async function that can be used directly as vite.config.js
 *
 * @example
 * // vite.config.js - simplest form
 * export { default } from '@uniweb/build/site/config'
 */
export default function (overrides = {}) {
  return defineSiteConfig(overrides)
}
