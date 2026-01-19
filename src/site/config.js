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
import { resolve, dirname } from 'node:path'
import yaml from 'js-yaml'

// Virtual module ID for the site entry
const VIRTUAL_ENTRY_ID = 'virtual:uniweb-site-entry'
const RESOLVED_VIRTUAL_ENTRY_ID = '\0' + VIRTUAL_ENTRY_ID

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
 * Generate the virtual entry module code based on foundation config
 *
 * @param {{ type: string, url?: string, cssUrl?: string }} foundationInfo
 * @param {boolean} isRuntimeMode
 * @returns {string}
 */
function generateEntryCode(foundationInfo, isRuntimeMode) {
  if (isRuntimeMode || foundationInfo.type === 'url') {
    // Runtime loading - foundation loaded dynamically
    const url = foundationInfo.url || '/foundation/foundation.js'
    const cssUrl = foundationInfo.cssUrl || '/foundation/assets/style.css'

    return `
import { initRuntime } from '@uniweb/runtime'

initRuntime({
  url: '${url}',
  cssUrl: '${cssUrl}'
})
`
  }

  // Bundled mode - foundation imported at build time
  return `
import { initRuntime } from '@uniweb/runtime'
import foundation from '#foundation'
import '#foundation/styles'

initRuntime(foundation)
`
}

/**
 * Create the virtual entry plugin
 */
function virtualEntryPlugin(foundationInfo, isRuntimeMode) {
  const entryCode = generateEntryCode(foundationInfo, isRuntimeMode)

  return {
    name: 'uniweb:virtual-entry',
    enforce: 'pre',
    resolveId(id) {
      if (id === VIRTUAL_ENTRY_ID) {
        return RESOLVED_VIRTUAL_ENTRY_ID
      }
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_ENTRY_ID) {
        return entryCode
      }
    }
  }
}

/**
 * Read and parse site.yml configuration
 *
 * @param {string} siteRoot - Path to site directory
 * @returns {Object}
 */
function readSiteConfig(siteRoot) {
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
  const [
    { default: tailwindcss },
    { default: react },
    { default: svgr },
    { siteContentPlugin },
    { foundationDevPlugin }
  ] = await Promise.all([
    import('@tailwindcss/vite'),
    import('@vitejs/plugin-react'),
    import('vite-plugin-svgr'),
    import('./plugin.js'),
    import('../dev/plugin.js')
  ])

  // Build the plugins array
  const plugins = [
    // Virtual entry module
    virtualEntryPlugin(foundationInfo, isRuntimeMode),

    // Standard plugins
    tailwindcss(),
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

  // Merge with user overrides
  const resolveConfig = {
    alias: {
      ...alias,
      ...resolveOverrides.alias
    },
    ...resolveOverrides
  }
  delete resolveConfig.alias // We'll add it back properly
  resolveConfig.alias = { ...alias, ...resolveOverrides.alias }

  return {
    plugins,

    resolve: {
      alias: {
        ...alias,
        ...resolveOverrides?.alias
      }
    },

    server: {
      fs: { allow: ['..'] },
      port: siteConfig.build?.port || 3000,
      ...serverOverrides
    },

    build: {
      ...buildOverrides
    },

    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
      exclude: ['virtual:uniweb-site-entry'],
      esbuildOptions: {
        plugins: [
          {
            name: 'virtual-entry-resolver',
            setup(build) {
              // Tell esbuild that virtual:uniweb-site-entry is external
              // This prevents the "could not be resolved" error during dep scanning
              build.onResolve({ filter: /^virtual:uniweb-site-entry$/ }, () => ({
                path: 'virtual:uniweb-site-entry',
                external: true
              }))
            }
          }
        ]
      }
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
