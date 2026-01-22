/**
 * Image Processing Utilities
 *
 * Handles preview image discovery, conversion to webp, and metadata extraction.
 * Preview images are editor metadata (for preset visualization) and are output
 * to dist/meta/previews/ to keep them separate from runtime assets.
 */

import { readdir, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import sharp from 'sharp'

// Supported image extensions
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

/**
 * Check if a file is an image based on extension
 */
function isImageFile(filename) {
  const ext = extname(filename).toLowerCase()
  return IMAGE_EXTENSIONS.includes(ext)
}

/**
 * Get image metadata (dimensions)
 */
async function getImageMetadata(imagePath) {
  try {
    const metadata = await sharp(imagePath).metadata()
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    }
  } catch (error) {
    console.warn(`Warning: Could not read metadata for ${imagePath}:`, error.message)
    return null
  }
}

/**
 * Convert an image to webp format
 */
async function convertToWebp(inputPath, outputPath, options = {}) {
  const { quality = 80 } = options

  try {
    await sharp(inputPath)
      .webp({ quality })
      .toFile(outputPath)
    return true
  } catch (error) {
    console.warn(`Warning: Could not convert ${inputPath} to webp:`, error.message)
    return false
  }
}

/**
 * Process preview images for a single component
 *
 * @param {string} componentDir - Path to component directory (e.g., src/components/Hero)
 * @param {string} componentName - Component name
 * @param {string} outputDir - Output directory for processed images
 * @param {boolean} isProduction - Whether to convert to webp
 * @returns {Object} Map of preset name to image info
 */
export async function processComponentPreviews(componentDir, componentName, outputDir, isProduction = true) {
  const previewsDir = join(componentDir, 'previews')
  const previews = {}

  if (!existsSync(previewsDir)) {
    return previews
  }

  // Create output directory for preview images (editor metadata)
  const componentOutputDir = join(outputDir, 'meta', 'previews', componentName)
  await mkdir(componentOutputDir, { recursive: true })

  // Get all image files
  const files = await readdir(previewsDir)
  const imageFiles = files.filter(isImageFile)

  for (const file of imageFiles) {
    const inputPath = join(previewsDir, file)
    const presetName = basename(file, extname(file))
    const originalExt = extname(file).toLowerCase()

    // Get original metadata
    const metadata = await getImageMetadata(inputPath)
    if (!metadata) continue

    let outputFilename
    let outputPath
    let finalFormat

    if (isProduction && originalExt !== '.webp') {
      // Convert to webp in production
      outputFilename = `${presetName}.webp`
      outputPath = join(componentOutputDir, outputFilename)
      finalFormat = 'webp'

      const success = await convertToWebp(inputPath, outputPath)
      if (!success) {
        // Fall back to copying original
        outputFilename = file
        outputPath = join(componentOutputDir, file)
        finalFormat = originalExt.slice(1)
        await copyFile(inputPath, outputPath)
      }
    } else {
      // Copy as-is in development or if already webp
      outputFilename = file
      outputPath = join(componentOutputDir, file)
      finalFormat = originalExt.slice(1)
      await copyFile(inputPath, outputPath)
    }

    previews[presetName] = {
      path: `meta/previews/${componentName}/${outputFilename}`,
      width: metadata.width,
      height: metadata.height,
      type: finalFormat,
    }
  }

  return previews
}

/**
 * Process all preview images for a foundation
 *
 * @param {string} srcDir - Source directory (e.g., src/)
 * @param {string} outputDir - Output directory (e.g., dist/)
 * @param {Object} schema - Schema object with components (each has `path` property)
 * @param {boolean} isProduction - Whether to convert to webp
 * @returns {Object} Updated schema with image references
 */
export async function processAllPreviews(srcDir, outputDir, schema, isProduction = true) {
  let totalImages = 0

  // Iterate through components in schema (skip _self)
  for (const [componentName, componentMeta] of Object.entries(schema)) {
    if (componentName === '_self') continue
    if (!componentMeta.path) continue

    const componentDir = join(srcDir, componentMeta.path)

    if (!existsSync(componentDir)) continue

    // Process preview images
    const previews = await processComponentPreviews(
      componentDir,
      componentName,
      outputDir,
      isProduction
    )

    const previewCount = Object.keys(previews).length
    if (previewCount > 0) {
      totalImages += previewCount

      // Attach preview info to presets in schema
      if (schema[componentName].presets) {
        for (const [presetName, previewInfo] of Object.entries(previews)) {
          if (schema[componentName].presets[presetName]) {
            schema[componentName].presets[presetName].image = previewInfo
          } else {
            // Preview exists but no matching preset - still include it
            // This allows standalone preview images
            if (!schema[componentName].images) {
              schema[componentName].images = {}
            }
            schema[componentName].images[presetName] = previewInfo
          }
        }
      } else {
        // No presets defined, add as standalone images
        schema[componentName].images = previews
      }
    }
  }

  return { schema, totalImages }
}

/**
 * Copy a single image with optional conversion
 */
export async function processImage(inputPath, outputPath, options = {}) {
  const { convertToWebp: shouldConvert = false, quality = 80 } = options

  const ext = extname(inputPath).toLowerCase()

  if (shouldConvert && ext !== '.webp') {
    const webpPath = outputPath.replace(/\.[^.]+$/, '.webp')
    const success = await convertToWebp(inputPath, webpPath, { quality })
    if (success) {
      return { path: webpPath, converted: true }
    }
  }

  // Copy as-is
  await mkdir(join(outputPath, '..'), { recursive: true })
  await copyFile(inputPath, outputPath)
  return { path: outputPath, converted: false }
}
