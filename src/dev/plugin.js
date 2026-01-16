/**
 * Vite Plugin: Foundation Dev Server
 *
 * Builds and serves a foundation within the site's dev server.
 * This enables a single dev server for both site and foundation development.
 *
 * @module @uniweb/build/dev
 *
 * @example
 * import { foundationDevPlugin } from '@uniweb/build/dev'
 *
 * export default defineConfig({
 *   plugins: [
 *     foundationDevPlugin({
 *       name: 'my-foundation',
 *       path: '../my-foundation',  // Path to foundation package
 *       serve: '/foundation',      // URL path to serve from
 *     })
 *   ]
 * })
 */

import { resolve, join } from 'node:path'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { build } from 'vite'

/**
 * Create the foundation dev plugin
 *
 * @param {Object} options
 * @param {string} [options.name='foundation'] - Foundation name (for logging)
 * @param {string} [options.path='../foundation'] - Path to foundation package
 * @param {string} [options.serve='/foundation'] - URL path to serve from
 * @param {boolean} [options.watch=true] - Watch for source changes
 * @param {boolean} [options.buildOnStart=true] - Build on server start
 */
export function foundationDevPlugin(options = {}) {
  const {
    name = 'foundation',
    path: foundationPath = '../foundation',
    serve: servePath = '/foundation',
    watch: shouldWatch = true,
    buildOnStart = true
  } = options

  let resolvedFoundationPath = null
  let resolvedDistPath = null
  let server = null
  let watcher = null
  let isBuilding = false
  let lastBuildTime = 0

  /**
   * Build the foundation using Vite
   */
  async function buildFoundation() {
    if (isBuilding) return
    isBuilding = true

    const startTime = Date.now()
    console.log(`[foundation] Building ${name}...`)

    try {
      // Use Vite's native config loading by specifying configFile
      const configPath = join(resolvedFoundationPath, 'vite.config.js')

      // Build using Vite with the foundation's own config file
      await build({
        root: resolvedFoundationPath,
        configFile: existsSync(configPath) ? configPath : false,
        logLevel: 'warn',
        build: {
          outDir: 'dist',
          emptyOutDir: true,
          watch: null // Don't use Vite's watch, we handle it ourselves
        }
      })

      lastBuildTime = Date.now()
      console.log(`[foundation] Built ${name} in ${lastBuildTime - startTime}ms`)

      // Trigger HMR reload if server is running
      if (server) {
        server.ws.send({ type: 'full-reload' })
      }
    } catch (err) {
      console.error(`[foundation] Build failed:`, err.message)
    } finally {
      isBuilding = false
    }
  }

  return {
    name: 'uniweb:foundation-dev',
    // Run before other plugins to intercept foundation requests
    enforce: 'pre',

    configResolved(config) {
      resolvedFoundationPath = resolve(config.root, foundationPath)
      resolvedDistPath = join(resolvedFoundationPath, 'dist')
    },

    async buildStart() {
      if (buildOnStart) {
        await buildFoundation()
      }
    },

    configureServer(devServer) {
      server = devServer

      // Serve foundation files via middleware
      // For JS files, use Vite's transform pipeline to properly resolve imports
      devServer.middlewares.use(async (req, res, next) => {
        const urlPath = req.url.split('?')[0]

        if (!urlPath.startsWith(servePath)) {
          return next()
        }

        const filePath = urlPath.slice(servePath.length) || '/foundation.js'
        const fullPath = join(resolvedDistPath, filePath)

        if (!existsSync(fullPath)) {
          return next()
        }

        try {
          let content = await readFile(fullPath, 'utf-8')
          let contentType = 'application/octet-stream'

          if (filePath.endsWith('.js')) {
            contentType = 'application/javascript'

            // Use Vite's transform pipeline to resolve bare imports
            // This properly handles React ESM/CJS interop
            const result = await devServer.transformRequest(`/@fs${fullPath}`, {
              html: false
            })

            if (result) {
              content = result.code
            }
          } else if (filePath.endsWith('.css')) {
            contentType = 'text/css'
          } else if (filePath.endsWith('.json')) {
            contentType = 'application/json'
          }

          res.setHeader('Content-Type', contentType)
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(content)
        } catch (err) {
          next(err)
        }
      })

      // Watch foundation source for changes
      if (shouldWatch) {
        const srcPath = join(resolvedFoundationPath, 'src')

        // Debounce rebuilds
        let rebuildTimeout = null
        const scheduleRebuild = () => {
          if (rebuildTimeout) clearTimeout(rebuildTimeout)
          rebuildTimeout = setTimeout(() => {
            buildFoundation()
          }, 200)
        }

        try {
          watcher = watch(srcPath, { recursive: true }, (eventType, filename) => {
            // Ignore non-source files
            if (
              filename &&
              (filename.endsWith('.js') ||
                filename.endsWith('.jsx') ||
                filename.endsWith('.ts') ||
                filename.endsWith('.tsx') ||
                filename.endsWith('.css') ||
                filename.endsWith('.svg'))
            ) {
              console.log(`[foundation] ${filename} changed`)
              scheduleRebuild()
            }
          })
          console.log(`[foundation] Watching ${srcPath}`)
        } catch (err) {
          console.warn(`[foundation] Could not watch source:`, err.message)
        }
      }
    },

    closeBundle() {
      if (watcher) {
        watcher.close()
        watcher = null
      }
    }
  }
}

export default foundationDevPlugin
