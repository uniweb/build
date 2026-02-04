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
import { generateEntryPoint } from '../generate-entry.js'

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
function detectFoundationType(foundation, siteRoot) {
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

  // Check if it's a local workspace sibling
  const localPath = resolve(siteRoot, '..', name)
  if (existsSync(localPath)) {
    return {
      type: 'local',
      name,
      path: localPath
    }
  }

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

  // Determine base path for deployment (priority: option > env > site.yml)
  // Normalize: ensure leading slash, collapse repeated slashes, add trailing slash for Vite
  const rawBase = baseOption || process.env.UNIWEB_BASE || siteConfig.base
  const base = rawBase ? normalizeBasePath(String(rawBase)) : undefined

  // Check for shell mode (no embedded content, for dynamic backend)
  const isShellMode = process.env.UNIWEB_SHELL === 'true'

  // Detect foundation type
  const foundationInfo = detectFoundationType(siteConfig.foundation, siteRoot)

  // Check for runtime mode (env variable, URL-based foundation, or shell mode)
  const isRuntimeMode =
    isShellMode || process.env.VITE_FOUNDATION_MODE === 'runtime' || foundationInfo.type === 'url'

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
      const srcDir = join(foundationInfo.path, 'src')
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
      // Watch foundation src for meta.js changes to regenerate entry
      const srcDir = join(foundationInfo.path, 'src')
      const entryPath = join(srcDir, '_entry.generated.js')

      server.watcher.add(join(srcDir, '**', 'meta.js'))

      server.watcher.on('all', async (event, path) => {
        // Regenerate entry when meta.js files change (new/deleted components)
        if (path.includes(srcDir) && path.endsWith('meta.js')) {
          console.log(`[site] Foundation meta.js changed, regenerating entry...`)
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
      inject: !isShellMode,
      shell: isShellMode,
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

  // Import map plugin for runtime mode production builds
  // Emits re-export modules for each externalized package (react, @uniweb/core, etc.)
  // so the browser can resolve bare specifiers in the dynamically-imported foundation
  const IMPORT_MAP_EXTERNALS = [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    '@uniweb/core'
  ]
  const IMPORT_MAP_PREFIX = '\0importmap:'

  const importMapPlugin = needsImportMap ? (() => {
    let isBuild = false

    return {
      name: 'uniweb:import-map',

      configResolved(config) {
        isBuild = config.command === 'build'
      },

      resolveId(id) {
        if (id.startsWith(IMPORT_MAP_PREFIX)) return id
      },

      async load(id) {
        if (!id.startsWith(IMPORT_MAP_PREFIX)) return
        const pkg = id.slice(IMPORT_MAP_PREFIX.length)
        // Dynamically discover exports at build time by importing the package.
        // We generate explicit named re-exports (not `export *`) because CJS
        // packages like React only expose a default via `export *`, losing
        // individual named exports (useState, jsx, etc.) that foundations need.
        try {
          const mod = await import(pkg)
          const names = Object.keys(mod).filter(k => k !== '__esModule')
          const hasDefault = 'default' in mod
          const named = names.filter(k => k !== 'default')
          const lines = []
          if (named.length) {
            lines.push(`export { ${named.join(', ')} } from '${pkg}'`)
          }
          if (hasDefault) {
            lines.push(`export { default } from '${pkg}'`)
          }
          return lines.join('\n') || `export {}`
        } catch {
          // Fallback: generic re-export (may not preserve named exports for CJS)
          return `export * from '${pkg}'`
        }
      },

      // Emit deterministic chunks for each external (production only).
      // preserveSignature: 'exports-only' tells Rollup to preserve the original
      // export names (useState, jsx, etc.) instead of mangling them.
      // In dev mode, Vite's transformRequest() resolves bare specifiers instead.
      buildStart() {
        if (!isBuild) return
        for (const ext of IMPORT_MAP_EXTERNALS) {
          this.emitFile({
            type: 'chunk',
            id: `${IMPORT_MAP_PREFIX}${ext}`,
            fileName: `_importmap/${ext.replace(/\//g, '-')}.js`,
            preserveSignature: 'exports-only'
          })
        }
      },

      // Inject the import map into the HTML (production only).
      // In dev mode, Vite's transformRequest() handles bare specifier resolution.
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          if (!isBuild) return html
          const basePath = base || '/'
          const imports = {}
          for (const ext of IMPORT_MAP_EXTERNALS) {
            imports[ext] = `${basePath}_importmap/${ext.replace(/\//g, '-')}.js`
          }
          const importMap = JSON.stringify({ imports }, null, 2)
          const script = `    <script type="importmap">\n${importMap}\n    </script>\n`
          // Import map must appear before any module scripts
          return html.replace('<head>', '<head>\n' + script)
        }
      }
    }
  })() : null

  if (importMapPlugin) plugins.push(importMapPlugin)

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
      __FOUNDATION_CONFIG__: isShellMode ? 'null' : JSON.stringify(foundationConfig)
    },

    resolve: {
      // Deduplicate React packages to prevent dual-instance issues
      // Foundation externalizes React; when site bundles it, CJS and ESM
      // copies can coexist without this, causing "useRef of null" errors
      dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
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
      include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom']
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
