/**
 * Vite Plugin for Foundation Builds
 *
 * Handles:
 * - Auto-generating entry point from discovered components
 * - Building schema.json from meta files
 * - Processing preview images for presets
 */

import { writeFile, mkdir } from 'node:fs/promises'
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
 * Worker externals — these are provided by the Cloudflare Worker's custom require()
 */
const WORKER_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/server',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@uniweb/core',
]

/**
 * Module-level guard to prevent recursive worker bundle builds.
 * When buildWorkerBundle calls viteBuild(), Vite may re-invoke the
 * foundation plugin's writeBundle hook — this flag breaks the cycle.
 */
let _buildingWorkerBundle = false

/**
 * Build a CJS worker bundle from the ESM foundation output.
 *
 * The Worker provides a custom require() that maps these externals
 * to its bundled modules. The CJS format is required because Workers
 * evaluate foundation code with `new Function()`, not ES module import.
 *
 * @param {string} outDir - Path to dist/ directory containing foundation.js
 */
async function buildWorkerBundle(outDir) {
  if (_buildingWorkerBundle) return
  _buildingWorkerBundle = true

  const entryPath = join(outDir, 'foundation.js')
  try {
    const { build: viteBuild } = await import('vite')
    await viteBuild({
      configFile: false,  // don't load project's vite.config.js
      plugins: [],
      build: {
        lib: {
          entry: entryPath,
          formats: ['cjs'],
          fileName: 'foundation.worker',
        },
        rollupOptions: {
          external: WORKER_EXTERNALS,
          output: { exports: 'named' },
        },
        outDir,
        emptyOutDir: false,
        sourcemap: false,
        minify: false,
      },
      logLevel: 'warn',
    })

    const { statSync } = await import('node:fs')
    const workerFile = join(outDir, 'foundation.worker.cjs')
    const size = (statSync(workerFile).size / 1024).toFixed(1)
    console.log(`Generated foundation.worker.cjs (${size} KB)`)
  } catch (err) {
    console.warn(`Warning: worker bundle build failed: ${err.message}`)
  } finally {
    _buildingWorkerBundle = false
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
      isProduction = config.mode === 'production'
    },

    async writeBundle() {
      // Skip if this is a recursive call from buildWorkerBundle
      if (_buildingWorkerBundle) return

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

      // Build CJS worker bundle for edge SSR
      await buildWorkerBundle(outDir)
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
