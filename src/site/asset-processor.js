/**
 * Asset Processor
 *
 * Processes site assets (images) during build:
 * - Converts images to WebP for optimization
 * - Generates content-hashed filenames for cache busting
 * - Caches processed assets to avoid redundant work
 *
 * @module @uniweb/build/site
 */

import { readFile, writeFile, mkdir, stat, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, extname, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

// Image formats that can be converted to WebP
const CONVERTIBLE_FORMATS = ['.png', '.jpg', '.jpeg', '.gif']

// Image formats to pass through without conversion
const PASSTHROUGH_FORMATS = ['.svg', '.webp', '.avif', '.ico']

/**
 * Generate a content hash for a file
 */
async function getFileHash(filePath) {
  const content = await readFile(filePath)
  return createHash('md5').update(content).digest('hex').slice(0, 8)
}

/**
 * Convert an image to WebP format
 *
 * @param {Buffer} input - Input image buffer
 * @param {Object} options - Conversion options
 * @returns {Promise<Buffer>} WebP buffer
 */
async function convertToWebp(input, options = {}) {
  const { quality = 80 } = options

  return sharp(input)
    .webp({ quality })
    .toBuffer()
}

/**
 * Process a single asset
 *
 * @param {Object} asset - Asset info from manifest
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Processed asset info
 */
export async function processAsset(asset, options = {}) {
  const {
    outputDir,
    assetsSubdir = 'assets',
    convertToWebp: shouldConvert = true,
    quality = 80
  } = options

  const { original, resolved, isImage } = asset

  // Check if source file exists
  if (!existsSync(resolved)) {
    console.warn(`[asset-processor] Source not found: ${resolved}`)
    return {
      original,
      output: original, // Keep original path as fallback
      processed: false,
      error: 'Source not found'
    }
  }

  const ext = extname(resolved).toLowerCase()
  const name = basename(resolved, ext)

  try {
    // Generate content hash for cache busting
    const hash = await getFileHash(resolved)

    let outputBuffer
    let outputExt = ext
    let converted = false

    if (isImage && shouldConvert && CONVERTIBLE_FORMATS.includes(ext)) {
      // Convert to WebP
      const input = await readFile(resolved)
      outputBuffer = await convertToWebp(input, { quality })
      outputExt = '.webp'
      converted = true
    } else if (isImage && PASSTHROUGH_FORMATS.includes(ext)) {
      // Copy as-is for SVG, WebP, etc.
      outputBuffer = await readFile(resolved)
    } else {
      // Non-image or unknown format - copy as-is
      outputBuffer = await readFile(resolved)
    }

    // Generate output filename with hash
    const outputFilename = `${name}-${hash}${outputExt}`
    const outputPath = join(outputDir, assetsSubdir, outputFilename)

    // Ensure output directory exists
    await mkdir(dirname(outputPath), { recursive: true })

    // Write processed file
    await writeFile(outputPath, outputBuffer)

    // Return the URL path (relative to site root)
    const outputUrl = `/${assetsSubdir}/${outputFilename}`

    return {
      original,
      output: outputUrl,
      resolved,
      outputPath,
      processed: true,
      converted,
      size: outputBuffer.length
    }
  } catch (error) {
    console.warn(`[asset-processor] Failed to process ${resolved}:`, error.message)
    return {
      original,
      output: original,
      processed: false,
      error: error.message
    }
  }
}

/**
 * Process all assets in a manifest
 *
 * @param {Object} assetManifest - Asset manifest from content collector
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Mapping of original paths to output URLs
 */
export async function processAssets(assetManifest, options = {}) {
  const pathMapping = {}
  const results = {
    processed: 0,
    converted: 0,
    failed: 0,
    totalSize: 0
  }

  const entries = Object.entries(assetManifest)

  for (const [originalPath, asset] of entries) {
    const result = await processAsset(asset, options)
    pathMapping[originalPath] = result.output

    if (result.processed) {
      results.processed++
      results.totalSize += result.size || 0
      if (result.converted) {
        results.converted++
      }
    } else {
      results.failed++
    }
  }

  return { pathMapping, results }
}

/**
 * Recursively rewrite asset paths in a data object
 *
 * @param {any} data - Parsed JSON/YAML data
 * @param {Object} pathMapping - Map of original paths to new paths
 * @returns {any} Data with rewritten paths
 */
function rewriteDataPaths(data, pathMapping) {
  if (typeof data === 'string') {
    return pathMapping[data] || data
  }

  if (Array.isArray(data)) {
    return data.map(item => rewriteDataPaths(item, pathMapping))
  }

  if (data && typeof data === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(data)) {
      result[key] = rewriteDataPaths(value, pathMapping)
    }
    return result
  }

  return data
}

/**
 * Rewrite asset paths in ProseMirror content
 *
 * @param {Object} content - ProseMirror document
 * @param {Object} pathMapping - Map of original paths to new paths
 * @returns {Object} Content with rewritten paths
 */
export function rewriteContentPaths(content, pathMapping) {
  if (!content) return content

  // Deep clone to avoid mutating original
  const result = JSON.parse(JSON.stringify(content))

  function walk(node) {
    // Rewrite image src
    if (node.type === 'image' && node.attrs?.src) {
      const newPath = pathMapping[node.attrs.src]
      if (newPath) {
        node.attrs.src = newPath
      }
    }

    // Rewrite paths in data blocks (structured data parsed at build time)
    if (node.type === 'dataBlock' && node.attrs?.data) {
      node.attrs.data = rewriteDataPaths(node.attrs.data, pathMapping)
    }

    // Recurse into content
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(walk)
    }

    // Check marks
    if (node.marks && Array.isArray(node.marks)) {
      node.marks.forEach(mark => {
        if (mark.attrs?.src) {
          const newPath = pathMapping[mark.attrs.src]
          if (newPath) {
            mark.attrs.src = newPath
          }
        }
      })
    }
  }

  walk(result)
  return result
}

/**
 * Rewrite asset paths in section params (frontmatter)
 *
 * @param {Object} params - Section params
 * @param {Object} pathMapping - Map of original paths to new paths
 * @returns {Object} Params with rewritten paths
 */
export function rewriteParamPaths(params, pathMapping) {
  if (!params) return params

  const result = { ...params }
  const imageFields = ['image', 'background', 'backgroundImage', 'thumbnail', 'poster', 'avatar', 'logo', 'icon']

  for (const field of imageFields) {
    if (result[field] && pathMapping[result[field]]) {
      result[field] = pathMapping[result[field]]
    }
  }

  return result
}

/**
 * Rewrite all asset paths in site content
 *
 * @param {Object} siteContent - Full site content object
 * @param {Object} pathMapping - Map of original paths to new paths
 * @returns {Object} Site content with rewritten paths
 */
export function rewriteSiteContentPaths(siteContent, pathMapping) {
  // Deep clone
  const result = JSON.parse(JSON.stringify(siteContent))

  function processSection(section) {
    if (section.content) {
      section.content = rewriteContentPaths(section.content, pathMapping)
    }
    if (section.params) {
      section.params = rewriteParamPaths(section.params, pathMapping)
    }
    if (section.subsections) {
      section.subsections.forEach(processSection)
    }
  }

  function processPage(page) {
    if (page.sections) {
      page.sections.forEach(processSection)
    }
  }

  // Process all pages
  if (result.pages) {
    result.pages.forEach(processPage)
  }

  // Process header and footer
  if (result.header) {
    processPage(result.header)
  }
  if (result.footer) {
    processPage(result.footer)
  }

  // Remove the assets manifest from output (no longer needed at runtime)
  delete result.assets

  return result
}
