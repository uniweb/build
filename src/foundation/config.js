/**
 * Foundation Vite Configuration
 *
 * Provides a zero-config or minimal-config Vite setup for Uniweb foundations.
 * Handles library mode, externals, and standard plugins.
 *
 * @module @uniweb/build/foundation/config
 *
 * @example
 * // Minimal vite.config.js (recommended)
 * import { defineFoundationConfig } from '@uniweb/build'
 *
 * export default defineFoundationConfig()
 *
 * @example
 * // With customization
 * import { defineFoundationConfig } from '@uniweb/build'
 *
 * export default defineFoundationConfig({
 *   entry: 'src/custom-entry.js',
 *   externals: ['lodash'],
 *   plugins: [myPlugin()],
 * })
 */

import { resolve } from 'node:path'
import { foundationPlugin } from '../vite-foundation-plugin.js'

/**
 * Default externals for foundations
 * These are not bundled into the foundation output
 */
/**
 * Default externals for foundations
 * These are provided by the runtime and should not be bundled
 */
const DEFAULT_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@uniweb/core'
]

/**
 * Create a complete Vite configuration for a Uniweb foundation
 *
 * @param {Object} [options={}] - Configuration options
 * @param {string} [options.entry] - Entry point path (default: 'src/_entry.generated.js')
 * @param {string} [options.fileName] - Output file name (default: 'foundation')
 * @param {string[]} [options.sections] - Paths to scan for section types (relative to src/).
 *                                       Default: ['sections']
 *                                       Example: ['sections', 'sections/marketing']
 * @param {string[]} [options.externals] - Additional packages to externalize
 * @param {boolean} [options.includeDefaultExternals] - Include default externals (default: true)
 * @param {Array} [options.plugins] - Additional Vite plugins
 * @param {boolean} [options.tailwind] - Include Tailwind CSS v4 plugin (default: true)
 * @param {boolean} [options.sourcemap] - Generate sourcemaps (default: true)
 * @param {Object} [options.build] - Additional build options to merge
 * @returns {Promise<Object>} Vite configuration
 */
export async function defineFoundationConfig(options = {}) {
  const {
    entry = 'src/_entry.generated.js',
    fileName = 'foundation',
    sections: sectionPaths,
    externals: additionalExternals = [],
    includeDefaultExternals = true,
    plugins: extraPlugins = [],
    tailwind = true,
    sourcemap = true,
    build: buildOverrides = {},
    ...restOptions
  } = options

  // Determine foundation root (where vite.config.js is)
  const foundationRoot = process.cwd()

  // Build externals list
  const externals = includeDefaultExternals
    ? [...DEFAULT_EXTERNALS, ...additionalExternals]
    : additionalExternals

  // Dynamic imports for optional peer dependencies
  const imports = [
    import('@vitejs/plugin-react'),
    import('vite-plugin-svgr')
  ]

  // Only import tailwind if enabled
  if (tailwind) {
    imports.unshift(import('@tailwindcss/vite'))
  }

  const modules = await Promise.all(imports)

  // Extract plugins based on what was imported
  let tailwindcss, react, svgr
  if (tailwind) {
    tailwindcss = modules[0].default
    react = modules[1].default
    svgr = modules[2].default
  } else {
    react = modules[0].default
    svgr = modules[1].default
  }

  // Build the plugins array
  // foundationPlugin handles entry generation and schema building
  const plugins = [
    foundationPlugin({ srcDir: 'src', sections: sectionPaths }),
    tailwind && tailwindcss(),
    react(),
    svgr(),
    ...extraPlugins
  ].filter(Boolean)

  return {
    plugins,

    build: {
      lib: {
        entry: resolve(foundationRoot, entry),
        formats: ['es'],
        fileName
      },
      rollupOptions: {
        external: externals,
        output: {
          assetFileNames: 'assets/[name][extname]'
        }
      },
      sourcemap,
      cssCodeSplit: false,
      ...buildOverrides
    },

    ...restOptions
  }
}

/**
 * Default export - an async function that can be used directly as vite.config.js
 *
 * @example
 * // vite.config.js - simplest form
 * export { default } from '@uniweb/build/foundation/config'
 */
export default function (overrides = {}) {
  return defineFoundationConfig(overrides)
}
