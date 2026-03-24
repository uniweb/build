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
 * Module-level guard to prevent recursive SSR bundle builds.
 * When buildSSRBundle calls esbuild, it should not re-trigger
 * the foundation plugin's writeBundle hook.
 */
let _buildingSSRBundle = false

/**
 * Build a self-contained ESM bundle for edge SSR (Dynamic Workers).
 *
 * Produces foundation.ssr.js — a single ESM file with React, ReactDOM/server,
 * @uniweb/core, and the foundation components all inlined. No external imports.
 *
 * This bundle is loaded into a Cloudflare Dynamic Worker isolate at request time
 * via env.LOADER.get(). The isolate caches the bundle per foundation version.
 *
 * @param {string} outDir - Path to dist/ directory containing foundation.js
 */
async function buildSSRBundle(outDir) {
  if (_buildingSSRBundle) return
  _buildingSSRBundle = true

  const entryPath = join(outDir, 'foundation.js')
  try {
    const { build: esbuild } = await import('esbuild')
    const { statSync } = await import('node:fs')

    // Find node_modules — walk up from outDir until we find one
    const { existsSync } = await import('node:fs')
    let searchDir = resolve(outDir, '..')
    let nodePaths = []
    for (let i = 0; i < 5; i++) {
      const candidate = join(searchDir, 'node_modules')
      if (existsSync(candidate)) {
        nodePaths.push(candidate)
        break
      }
      searchDir = resolve(searchDir, '..')
    }

    await esbuild({
      stdin: {
        contents: [
          `export { renderToString } from "react-dom/server.browser";`,
          `export { createElement } from "react";`,
          `export * from "${entryPath.replace(/\\/g, '/')}";`,
        ].join('\n'),
        resolveDir: outDir,
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outfile: join(outDir, 'foundation.ssr.js'),
      minify: false,
      external: [],
      nodePaths,
      conditions: ['browser', 'module'],
      logLevel: 'warning',
    })

    const ssrFile = join(outDir, 'foundation.ssr.js')
    const size = (statSync(ssrFile).size / 1024).toFixed(1)
    console.log(`Generated foundation.ssr.js (${size} KB)`)
  } catch (err) {
    console.warn(`Warning: SSR bundle build failed: ${err.message}`)
  } finally {
    _buildingSSRBundle = false
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
      // Skip if this is a recursive call from buildSSRBundle
      if (_buildingSSRBundle) return

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

      // Build self-contained SSR bundle for edge rendering (Dynamic Workers)
      await buildSSRBundle(outDir)
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
