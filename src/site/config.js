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
import { generateEntryPoint, shouldRegenerateForFile } from '../generate-entry.js'
import { importMapPlugin } from '../import-map-plugin.js'
import { resolveFoundationSrcPath } from '../utils/foundation-source-root.js'

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

/**
 * Detect foundation type from the foundation config value
 *
 * @param {string|Object} foundation - Foundation config from site.yml
 * @returns {{ type: 'local'|'npm'|'url', name?: string, url?: string, cssUrl?: string, path?: string }}
 */
export function detectFoundationType(foundation, siteRoot) {
  // Object form with explicit URL
  if (foundation && typeof foundation === 'object') {
    if (foundation.url) {
      return {
        type: 'url',
        url: foundation.url,
        cssUrl: foundation.css || foundation.cssUrl || null
      }
    }
    // Object form with name
    foundation = foundation.name || 'foundation'
  }

  // String form
  const name = foundation || 'foundation'

  // Check if it's a URL
  if (name.startsWith('http://') || name.startsWith('https://')) {
    // Try to infer CSS URL from JS URL
    const cssUrl = name.replace(/\.js$/, '.css').replace(/foundation\.js/, 'assets/style.css')
    return {
      type: 'url',
      url: name,
      cssUrl
    }
  }

  // Registry scoped ref. Two shapes:
  //   `@org/name@version`  — org scope, namespace is a lowercase slug
  //   `~uuid/name@version` — personal scope, namespace is a base58 memberUuid
  //                          (mixed case allowed). Server-rewritten from
  //                          empty-scope (bare-name) publishes.
  // Both are link-mode by definition — the foundation lives on the hosting
  // edge (R2) and is loaded at runtime. Surfacing this as `type: 'url'`
  // makes Vite skip the local-foundation bundling path and use the noop
  // virtual module. Base URL defaults to the production worker but is
  // overridable via UNIWEB_REGISTRY_URL for self-hosted / staging.
  const orgScopedMatch = /^@([a-z0-9_-]+)\/([a-z0-9_-]+)@(.+)$/.exec(name)
  const personalScopedMatch = /^~([A-Za-z0-9_-]+)\/([a-z0-9_-]+)@(.+)$/.exec(name)
  if (orgScopedMatch || personalScopedMatch) {
    const base = process.env.UNIWEB_REGISTRY_URL || 'https://site-router.uniweb-edge.workers.dev'
    if (orgScopedMatch) {
      const [, ns, fn, ver] = orgScopedMatch
      // Legacy plain-slash URL form (preserved — worker still accepts it
      // for back-compat with sites built against earlier CLI releases).
      return {
        type: 'url',
        url: `${base}/foundations/${ns}/${fn}/${ver}/foundation.js`,
        cssUrl: `${base}/foundations/${ns}/${fn}/${ver}/assets/foundation.css`
      }
    }
    // Personal-scope URL form — sigil + canonical `<name>@<version>` shape.
    // The worker only accepts this exact form for personal scopes (the
    // plain-slash form is org-scope-only).
    const [, uuid, fn, ver] = personalScopedMatch
    return {
      type: 'url',
      url: `${base}/foundations/~${uuid}/${fn}@${ver}/foundation.js`,
      cssUrl: `${base}/foundations/~${uuid}/${fn}@${ver}/assets/foundation.css`
    }
  }

  // Check if it's a local workspace sibling (directory name matches package name)
  const localPath = resolve(siteRoot, '..', name)
  if (existsSync(localPath)) {
    return {
      type: 'local',
      name,
      path: localPath
    }
  }

  // Check if it's a file: dependency (co-located projects where dir name ≠ package name)
  // e.g. "marketing-foundation": "file:../foundation" in marketing/site/package.json
  try {
    const pkg = JSON.parse(readFileSync(resolve(siteRoot, 'package.json'), 'utf8'))
    const dep = pkg.dependencies?.[name]
    if (dep && dep.startsWith('file:')) {
      const filePath = resolve(siteRoot, dep.slice(5))
      if (existsSync(filePath)) {
        return {
          type: 'local',
          name,
          path: filePath
        }
      }
    }
  } catch {}

  // Check in foundations/ directory (for multi-site projects)
  const foundationsPath = resolve(siteRoot, '..', '..', 'foundations', name)
  if (existsSync(foundationsPath)) {
    return {
      type: 'local',
      name,
      path: foundationsPath
    }
  }

  // Assume npm package
  return {
    type: 'npm',
    name,
    path: resolve(siteRoot, 'node_modules', name)
  }
}

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
 * Read and parse intelligence.yml configuration (AI knowledge page settings).
 *
 * Returns the non-secret fields. The `apiKey` field (if present) uses the
 * `env:VAR_NAME` syntax for CLI/local dev — the actual key is never stored
 * in artifacts or published content.
 *
 * @param {string} siteRoot - Path to site directory
 * @returns {Object|null} Parsed intelligence config, or null if no file exists
 */
export function readIntelligenceConfig(siteRoot) {
  const configPath = resolve(siteRoot, 'intelligence.yml')
  if (!existsSync(configPath)) return null

  try {
    return yaml.load(readFileSync(configPath, 'utf8')) || {}
  } catch (err) {
    console.warn('[site-config] Failed to read intelligence.yml:', err.message)
    return null
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
export async function defineSiteConfig(options = {}) {
  const {
    plugins: extraPlugins = [],
    server: serverOverrides = {},
    build: buildOverrides = {},
    resolve: resolveOverrides = {},
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

  // Allow callers to override `foundation:` without modifying site.yml on
  // disk. Used by `uniweb deploy` to substitute a workspace-local file: ref
  // with the resolved registry ref (`@ns/name@ver`) for the duration of the
  // deploy build, so the site builds in runtime/link mode against the just-
  // published artifact instead of bundling the local source.
  const foundationOverride = process.env.UNIWEB_FOUNDATION_REF
  if (foundationOverride) {
    siteConfig.foundation = foundationOverride
  }

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
      // Watch foundation src for structural changes that affect the entry
      const srcDir = resolveFoundationSrcPath(foundationInfo.path)
      const entryPath = join(srcDir, '_entry.generated.js')

      server.watcher.add(srcDir)

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
          // derive CSS URLs for all extension formats)
          const extensions = siteConfig.extensions || []
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

  // Build foundation config for runtime
  const foundationConfig = {
    mode: isRuntimeMode ? 'runtime' : 'bundled',
    url: foundationInfo.url || '/foundation/foundation.js',
    cssUrl: foundationInfo.cssUrl || '/foundation/assets/style.css'
  }

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
          for (const key of ['pages', 'layout', 'collections']) {
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

    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-router-dom'],
      exclude: ['#foundation']
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
