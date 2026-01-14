/**
 * Vite Plugin for Foundation Builds
 *
 * Handles:
 * - Auto-generating entry point from discovered components
 * - Building schema.json from meta files
 * - Processing preview images for presets
 */

import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { buildSchema, discoverComponents } from './schema.js'
import { generateEntryPoint } from './generate-entry.js'
import { processAllPreviews } from './images.js'

/**
 * Build schema.json with preview image references
 */
async function buildSchemaWithPreviews(srcDir, outDir, isProduction) {
  const schema = await buildSchema(srcDir)

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
 * Vite plugin for foundation builds
 */
export function foundationBuildPlugin(options = {}) {
  const {
    srcDir = 'src',
    generateEntry = true,
    entryFileName = '_entry.generated.js',
  } = options

  let resolvedSrcDir
  let resolvedOutDir
  let isProduction

  return {
    name: 'uniweb-foundation-build',

    async configResolved(config) {
      resolvedSrcDir = resolve(config.root, srcDir)
      resolvedOutDir = config.build.outDir
      isProduction = config.mode === 'production'
    },

    async buildStart() {
      if (!generateEntry) return

      // Generate entry point before build starts
      const entryPath = join(resolvedSrcDir, entryFileName)
      await generateEntryPoint(resolvedSrcDir, entryPath)
    },

    async writeBundle() {
      // After bundle is written, generate schema.json
      const outDir = resolve(resolvedOutDir)

      const schema = await buildSchemaWithPreviews(
        resolvedSrcDir,
        outDir,
        isProduction
      )

      const schemaPath = join(outDir, 'schema.json')
      await writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf-8')

      console.log(`Generated schema.json with ${Object.keys(schema).length - 1} components`)
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
  } = options

  let resolvedSrcDir

  return {
    name: 'uniweb-foundation-dev',

    configResolved(config) {
      resolvedSrcDir = resolve(config.root, srcDir)
    },

    async buildStart() {
      // Generate entry point at dev server start
      const entryPath = join(resolvedSrcDir, entryFileName)
      await generateEntryPoint(resolvedSrcDir, entryPath)
    },

    async handleHotUpdate({ file, server }) {
      // Regenerate entry when meta files change
      if (file.includes('/components/') && file.match(/meta\.(js|yml)$|config\.(js|yml)$/)) {
        console.log('Meta file changed, regenerating entry...')
        const entryPath = join(resolvedSrcDir, entryFileName)
        await generateEntryPoint(resolvedSrcDir, entryPath)

        // Trigger full reload since entry changed
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

    configResolved(config) {
      buildPlugin.configResolved?.(config)
      devPlugin.configResolved?.(config)
    },

    async buildStart() {
      await devPlugin.buildStart?.()
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
