/**
 * Asset Resolution Utilities
 *
 * Resolves asset paths in content to file system locations.
 * Supports both relative paths (./image.png) and absolute paths (/images/hero.png).
 *
 * In content-driven sites, markdown is the "code" - local asset references
 * act as implicit imports and should be processed/optimized during build.
 */

import { join, dirname, isAbsolute, normalize } from 'node:path'
import { existsSync } from 'node:fs'

// Image extensions we should process
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']

// Video extensions we can extract posters from
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv']

// PDF extension
const PDF_EXTENSION = '.pdf'

/**
 * Check if a path is an external URL
 */
function isExternalUrl(src) {
  return /^(https?:)?\/\//.test(src) || src.startsWith('data:')
}

/**
 * Check if a path is a processable image
 */
function isImagePath(src) {
  const ext = src.split('.').pop()?.toLowerCase()
  return IMAGE_EXTENSIONS.some(e => e.slice(1) === ext)
}

/**
 * Check if a path is a video file
 */
function isVideoPath(src) {
  const ext = '.' + (src.split('.').pop()?.toLowerCase() || '')
  return VIDEO_EXTENSIONS.includes(ext)
}

/**
 * Check if a path is a PDF file
 */
function isPdfPath(src) {
  return src.toLowerCase().endsWith(PDF_EXTENSION)
}

/**
 * Resolve an asset path to absolute file system path
 *
 * @param {string} src - Original source path from content
 * @param {string} contextPath - Path of the file containing the reference
 * @param {string} siteRoot - Site root directory
 * @returns {Object} Resolution result
 */
export function resolveAssetPath(src, contextPath, siteRoot) {
  // External URLs - don't process
  if (isExternalUrl(src)) {
    return { src, resolved: null, external: true }
  }

  // Already absolute path on filesystem
  if (isAbsolute(src)) {
    return { src, resolved: src, external: false }
  }

  let resolved

  // Relative paths: ./image.png or ../image.png or just image.png
  if (src.startsWith('./') || src.startsWith('../') || !src.startsWith('/')) {
    const contextDir = dirname(contextPath)
    resolved = normalize(join(contextDir, src))
  }
  // Absolute site paths: /images/hero.png
  else if (src.startsWith('/')) {
    // Check public folder first, then assets folder
    const publicPath = join(siteRoot, 'public', src)
    const assetsPath = join(siteRoot, 'assets', src)

    if (existsSync(publicPath)) {
      resolved = publicPath
    } else if (existsSync(assetsPath)) {
      resolved = assetsPath
    } else {
      // Default to public folder path even if it doesn't exist yet
      resolved = publicPath
    }
  }

  return {
    src,
    resolved,
    external: false,
    isImage: isImagePath(src),
    isVideo: isVideoPath(src),
    isPdf: isPdfPath(src)
  }
}

/**
 * Walk a ProseMirror document and collect all asset references
 *
 * @param {Object} doc - ProseMirror document
 * @param {Function} visitor - Callback for each asset: (node, path, attrName) => void
 *                             attrName is 'src', 'poster', or 'preview'
 * @param {string} [path=''] - Current path in document (for debugging)
 */
export function walkContentAssets(doc, visitor, path = '') {
  if (!doc) return

  // Check for image nodes
  if (doc.type === 'image' && doc.attrs?.src) {
    visitor(doc, path, 'src')

    // Also collect explicit poster/preview attributes as assets
    if (doc.attrs.poster && !isExternalUrl(doc.attrs.poster)) {
      visitor({ type: 'image', attrs: { src: doc.attrs.poster } }, path, 'poster')
    }
    if (doc.attrs.preview && !isExternalUrl(doc.attrs.preview)) {
      visitor({ type: 'image', attrs: { src: doc.attrs.preview } }, path, 'preview')
    }
  }

  // Recurse into content
  if (doc.content && Array.isArray(doc.content)) {
    doc.content.forEach((child, index) => {
      walkContentAssets(child, visitor, `${path}/content[${index}]`)
    })
  }

  // Handle marks (links can have images)
  if (doc.marks && Array.isArray(doc.marks)) {
    doc.marks.forEach((mark, index) => {
      if (mark.attrs?.src) {
        visitor(mark, `${path}/marks[${index}]`, 'src')
      }
    })
  }
}

/**
 * Process all assets in a section's content and frontmatter
 *
 * @param {Object} section - Section object with content and params
 * @param {string} markdownPath - Path to the markdown file
 * @param {string} siteRoot - Site root directory
 * @returns {Object} Asset collection result
 *   - assets: Asset manifest mapping original paths to resolved info
 *   - hasExplicitPoster: Set of video src paths that have explicit poster attributes
 *   - hasExplicitPreview: Set of PDF src paths that have explicit preview attributes
 */
export function collectSectionAssets(section, markdownPath, siteRoot) {
  const assets = {}
  const hasExplicitPoster = new Set()
  const hasExplicitPreview = new Set()

  // Track current image node's src when we encounter poster/preview
  let currentImageSrc = null

  // Collect from ProseMirror content
  if (section.content) {
    walkContentAssets(section.content, (node, path, attrName) => {
      const result = resolveAssetPath(node.attrs.src, markdownPath, siteRoot)

      if (attrName === 'src') {
        // Main src attribute - track it for potential poster/preview
        currentImageSrc = node.attrs.src

        // Check if this image has explicit poster/preview
        if (node.attrs.poster) {
          hasExplicitPoster.add(node.attrs.src)
        }
        if (node.attrs.preview) {
          hasExplicitPreview.add(node.attrs.src)
        }
      }

      if (!result.external && result.resolved) {
        assets[node.attrs.src] = {
          original: node.attrs.src,
          resolved: result.resolved,
          isImage: result.isImage,
          isVideo: result.isVideo,
          isPdf: result.isPdf
        }
      }
    })
  }

  // Collect from frontmatter params (common media fields)
  const mediaFields = [
    'image', 'background', 'backgroundImage', 'thumbnail',
    'poster', 'avatar', 'logo', 'icon',
    'video', 'videoSrc', 'media', 'file', 'pdf', 'document'
  ]

  for (const field of mediaFields) {
    const value = section.params?.[field]
    if (typeof value === 'string' && value) {
      const result = resolveAssetPath(value, markdownPath, siteRoot)
      if (!result.external && result.resolved) {
        assets[value] = {
          original: value,
          resolved: result.resolved,
          isImage: result.isImage,
          isVideo: result.isVideo,
          isPdf: result.isPdf
        }
      }
    }
  }

  return { assets, hasExplicitPoster, hasExplicitPreview }
}

/**
 * Merge multiple asset collection results
 *
 * @param {...Object} collections - Asset collection results from collectSectionAssets
 * @returns {Object} Merged collection with combined assets and sets
 */
export function mergeAssetCollections(...collections) {
  const merged = {
    assets: {},
    hasExplicitPoster: new Set(),
    hasExplicitPreview: new Set()
  }

  for (const collection of collections) {
    // Handle both old format (plain object) and new format (with sets)
    if (collection.assets) {
      Object.assign(merged.assets, collection.assets)
      collection.hasExplicitPoster?.forEach(p => merged.hasExplicitPoster.add(p))
      collection.hasExplicitPreview?.forEach(p => merged.hasExplicitPreview.add(p))
    } else {
      // Legacy: plain asset manifest
      Object.assign(merged.assets, collection)
    }
  }

  return merged
}
