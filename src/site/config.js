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
    ...restOptions
  } = options

  // Determine site root (where vite.config.js is)
  const siteRoot = process.cwd()

  // Read site.yml
  const siteConfig = readSiteConfig(siteRoot)

  // Detect foundation type
  const foundationInfo = detectFoundationType(siteConfig.foundation, siteRoot)

  // Check for runtime mode (env variable or URL-based foundation)
  const isRuntimeMode =
    process.env.VITE_FOUNDATION_MODE === 'runtime' || foundationInfo.type === 'url'

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
      inject: true,
      seo,
      assets,
      search
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

  // Set up #foundation alias for bundled mode
  if (!isRuntimeMode && foundationInfo.type !== 'url') {
    alias['#foundation'] = foundationInfo.name
  }

  // Build foundation config for runtime
  const foundationConfig = {
    mode: isRuntimeMode ? 'runtime' : 'bundled',
    url: foundationInfo.url || '/foundation/foundation.js',
    cssUrl: foundationInfo.cssUrl || '/foundation/assets/style.css'
  }

  return {
    plugins,

    define: {
      __FOUNDATION_CONFIG__: JSON.stringify(foundationConfig)
    },

    resolve: {
      alias: {
        ...alias,
        ...resolveOverrides?.alias
      }
    },

    server: {
      fs: {
        // Allow parent directory for foundation sibling access
        allow: ['..']
      },
      port: siteConfig.build?.port || 3000,
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
