/**
 * Asset Resolution Utilities
 *
 * Resolves asset paths in content to file system locations.
 * Supports both relative paths (./image.png) and absolute paths (/images/hero.png).
 *
 * In content-driven sites, markdown is the "code" - local asset references
 * act as implicit imports and should be processed/optimized during build.
 */

import { join, dirname, isAbsolute, normalize, relative, sep } from 'node:path'
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
 * Check if a string looks like a local asset path
 *
 * @param {string} value - String to check
 * @returns {boolean} True if it looks like a local asset path
 */
export function isLocalAssetPath(value) {
  if (typeof value !== 'string' || !value) return false

  // Skip external URLs
  if (isExternalUrl(value)) return false

  // Must start with ./, ../, or / (absolute site path)
  if (!value.startsWith('./') && !value.startsWith('../') && !value.startsWith('/')) {
    return false
  }

  // Must have a media extension
  return isImagePath(value) || isVideoPath(value) || isPdfPath(value)
}

/**
 * Check whether a frontmatter media-field value (`background`, `image`,
 * `poster`, …) is an asset *reference* rather than a CSS value.
 *
 * `background` is dual-use: it can be an image/video path OR a CSS color
 * (`gray`, `#fff`, `oklch(…)`), a gradient (`linear-gradient(…)`), or a palette
 * token (`primary-900`). The runtime's `Block.normalizeBackground` already
 * classifies these — a string is image/video only when it's path-like or
 * carries a media extension; everything else is a color/gradient. The build
 * must apply the SAME rule, otherwise a bare color like `gray` gets resolved as
 * a relative path (`<page-dir>/gray`) and the asset-processor logs a spurious
 * "Source not found" for a file that was never meant to exist.
 *
 * Looser than `isLocalAssetPath` (which requires BOTH a `./`/`../`/`/` prefix
 * AND an extension): a bare relative `hero.jpg` is a valid asset reference, so a
 * media extension alone qualifies.
 *
 * @param {*} value - Frontmatter field value
 * @returns {boolean} True if it should be resolved as a local asset
 */
export function isMediaFieldReference(value) {
  if (typeof value !== 'string' || !value) return false
  // External media is loaded at runtime from its URL, not processed here.
  if (isExternalUrl(value)) return false
  // Path-like values are asset references (even without an extension).
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) return true
  // Otherwise only a media extension makes it an asset (vs. a color/token).
  return isImagePath(value) || isVideoPath(value) || isPdfPath(value)
}

/**
 * Recursively walk a parsed data object and collect asset paths
 *
 * @param {any} data - Parsed JSON/YAML data
 * @param {Function} visitor - Callback for each asset path: (path) => void
 */
function walkDataAssets(data, visitor, set) {
  if (typeof data === 'string') {
    if (isLocalAssetPath(data)) {
      visitor(data, set)
    }
    return
  }

  if (Array.isArray(data)) {
    data.forEach((item, i) => walkDataAssets(item, visitor, (v) => { data[i] = v }))
    return
  }

  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      walkDataAssets(value, visitor, (v) => { data[key] = v })
    }
  }
}

/**
 * Walk ProseMirror content and collect assets from data blocks
 * Data blocks have pre-parsed structured data (parsed at content-reader build time)
 *
 * @param {Object} doc - ProseMirror document
 * @param {Function} visitor - Callback for each asset: (path) => void
 */
function walkDataBlockAssets(doc, visitor) {
  if (!doc) return

  // dataBlock nodes have pre-parsed data in attrs.data
  if (doc.type === 'dataBlock' && doc.attrs?.data) {
    const attrs = doc.attrs
    walkDataAssets(attrs.data, visitor, (v) => { attrs.data = v })
  }

  // Recurse into content
  if (doc.content && Array.isArray(doc.content)) {
    doc.content.forEach(child => walkDataBlockAssets(child, visitor))
  }
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

  // Already absolute path on filesystem (e.g., /Users/foo/bar.jpg)
  // Must actually exist — otherwise it's a site-relative path like /images/hero.jpg
  if (isAbsolute(src) && existsSync(src)) {
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
 * @param {Function} visitor - Callback for each asset: (node, path, attrName, holder) => void
 *                             attrName is 'src', 'poster', or 'preview'; `holder` is
 *                             the attrs object the reference lives on, at `holder[attrName]`
 * @param {string} [path=''] - Current path in document (for debugging)
 */
export function walkContentAssets(doc, visitor, path = '') {
  if (!doc) return

  // Check for image nodes
  if (doc.type === 'image' && doc.attrs?.src) {
    visitor(doc, path, 'src', doc.attrs)

    // Also collect explicit poster/preview attributes as assets
    if (doc.attrs.poster && !isExternalUrl(doc.attrs.poster)) {
      visitor({ type: 'image', attrs: { src: doc.attrs.poster } }, path, 'poster', doc.attrs)
    }
    if (doc.attrs.preview && !isExternalUrl(doc.attrs.preview)) {
      visitor({ type: 'image', attrs: { src: doc.attrs.preview } }, path, 'preview', doc.attrs)
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
        visitor(mark, `${path}/marks[${index}]`, 'src', mark.attrs)
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
 *   - uses: every co-located reference, with the file it resolved to and a setter
 *     for the place it is written — what `disambiguateAssetRefs` needs to rename
 *     one. In memory only; never part of the site content.
 */
export function collectSectionAssets(section, markdownPath, siteRoot) {
  const assets = {}
  const hasExplicitPoster = new Set()
  const hasExplicitPreview = new Set()
  const uses = []

  // One entry per reference. `set` writes a new reference where this one stands;
  // `flags` carries the explicit-poster/preview marks a renamed video/PDF must keep.
  const add = (ref, set, flags = null) => {
    const result = resolveAssetPath(ref, markdownPath, siteRoot)
    if (result.external || !result.resolved) return
    assets[ref] = {
      original: ref,
      resolved: result.resolved,
      isImage: result.isImage,
      isVideo: result.isVideo,
      isPdf: result.isPdf
    }
    // Only a co-located ref depends on WHERE it is written, so only it can name
    // two different files with one string. A site-root ref (`/x.png`) cannot.
    if (!ref.startsWith('/') && set) uses.push({ ref, resolved: result.resolved, set, flags })
  }

  // Collect from ProseMirror content
  if (section.content) {
    walkContentAssets(section.content, (node, path, attrName, holder) => {
      const ref = node.attrs.src
      let flags = null
      if (attrName === 'src') {
        // Check if this image has explicit poster/preview
        if (node.attrs.poster) hasExplicitPoster.add(ref)
        if (node.attrs.preview) hasExplicitPreview.add(ref)
        flags = { poster: !!node.attrs.poster, preview: !!node.attrs.preview }
      }
      add(ref, holder ? (v) => { holder[attrName] = v } : null, flags)
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
    // Only resolve values that are actually asset references. A dual-use field
    // like `background: gray` (a CSS color) must not be treated as a file path.
    if (isMediaFieldReference(value)) {
      add(value, (v) => { section.params[field] = v })
    }
  }

  // Collect from structured background object
  // Background can be { image: { src }, video: { src } } with nested asset paths
  const bg = section.params?.background
  if (bg && typeof bg === 'object') {
    for (const media of [bg.image, bg.video]) {
      if (typeof media?.src === 'string') add(media.src, (v) => { media.src = v })
    }
  }

  // Collect from tagged code blocks (JSON/YAML data)
  if (section.content) {
    walkDataBlockAssets(section.content, (assetPath, set) => add(assetPath, set))
  }

  return { assets, hasExplicitPoster, hasExplicitPreview, uses }
}

/**
 * Give every co-located reference that names more than one file its own key.
 *
 * The manifest is keyed by the reference AS WRITTEN, site-wide, and a co-located
 * ref means a different file in every folder — so two pages that both wrote
 * `./media/shot.png` shared one entry: the last one collected won, and both pages
 * rendered its image. Each colliding use is renamed to its file's path from the
 * site root (`./pages/alpha/media/shot.png`, or `../…` for a mounted folder
 * outside it), which is one key per file by construction and keeps the extension
 * the later steps classify by. A ref that names one file keeps its key, so a
 * site without a collision is unchanged.
 *
 * Call it on the merged page + layout collection, before the site config's assets
 * (which have no written place to rename) are merged in.
 *
 * @param {Object} collection - merged asset collection (mutated in place)
 * @param {string} siteRoot - Site root directory
 * @returns {number} how many references were renamed
 */
export function disambiguateAssetRefs(collection, siteRoot) {
  const uses = collection.uses || []
  const filesByRef = new Map()
  for (const use of uses) {
    if (!filesByRef.has(use.ref)) filesByRef.set(use.ref, new Set())
    filesByRef.get(use.ref).add(use.resolved)
  }

  let renamed = 0
  for (const use of uses) {
    if (filesByRef.get(use.ref).size < 2) continue
    const fromRoot = relative(siteRoot, use.resolved).split(sep).join('/')
    const key = fromRoot.startsWith('../') ? fromRoot : `./${fromRoot}`
    const entry = collection.assets[use.ref]
    collection.assets[key] = { ...entry, original: key, resolved: use.resolved }
    if (use.flags?.poster) collection.hasExplicitPoster?.add(key)
    if (use.flags?.preview) collection.hasExplicitPreview?.add(key)
    use.set(key)
    renamed++
  }
  // The shared key no longer names anything written in the content.
  for (const [ref, files] of filesByRef) {
    if (files.size < 2) continue
    delete collection.assets[ref]
    collection.hasExplicitPoster?.delete(ref)
    collection.hasExplicitPreview?.delete(ref)
  }
  return renamed
}

/**
 * Walk the top-level config object (site.yml / document.yml) for asset
 * references and resolve each into a manifest entry. Catches things like
 * book.covers.front, banner images, logos in metadata blocks — anything
 * declared in the config that points at a local file by path.
 *
 * Result is keyed by the original source string (the value as it appears
 * in the config). Foundations look up `website.assets[src]` at compile
 * time and resolve `entry.resolved` to a filesystem path or `entry.url`
 * to a URL, depending on the runtime context. This keeps foundations
 * environment-agnostic — they don't need to know whether the compile
 * pipeline runs in Node (unipress) or in the browser (editor).
 *
 * `walkDataAssets` already filters via `isLocalAssetPath` to skip
 * non-asset strings (titles, descriptions, etc.).
 *
 * @param {Object} siteConfig - Parsed top-level config
 * @param {string} siteRoot - Site/document root directory
 * @returns {Object} Asset manifest keyed by original src string
 */
export function collectConfigAssets(siteConfig, siteRoot) {
  const assets = {}
  if (!siteConfig || typeof siteConfig !== 'object') return assets

  // Anchor for relative-path resolution — `dirname(anchor)` must equal siteRoot
  // so `assets/front.png` resolves to `<siteRoot>/assets/front.png`.
  const anchor = `${siteRoot}/_config_anchor`

  // Walk siteConfig with a more permissive filter than `isLocalAssetPath`:
  // config asset paths often appear without a `./` prefix (e.g.
  // `book.covers.front: assets/front.png`), which is the natural spelling
  // for authors. Accept any string with a media extension that isn't an
  // external URL.
  const visit = (data) => {
    if (typeof data === 'string') {
      if (isExternalUrl(data)) return
      if (!(isImagePath(data) || isVideoPath(data) || isPdfPath(data))) return
      const result = resolveAssetPath(data, anchor, siteRoot)
      if (!result.external && result.resolved) {
        assets[data] = {
          original: data,
          resolved: result.resolved,
          isImage: result.isImage,
          isVideo: result.isVideo,
          isPdf: result.isPdf
        }
      }
      return
    }
    if (Array.isArray(data)) {
      data.forEach(visit)
      return
    }
    if (data && typeof data === 'object') {
      Object.values(data).forEach(visit)
    }
  }

  visit(siteConfig)
  return assets
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
    hasExplicitPreview: new Set(),
    uses: []
  }

  for (const collection of collections) {
    // Handle both old format (plain object) and new format (with sets)
    if (collection.assets) {
      Object.assign(merged.assets, collection.assets)
      if (collection.uses) merged.uses.push(...collection.uses)
      collection.hasExplicitPoster?.forEach(p => merged.hasExplicitPoster.add(p))
      collection.hasExplicitPreview?.forEach(p => merged.hasExplicitPreview.add(p))
    } else {
      // Legacy: plain asset manifest
      Object.assign(merged.assets, collection)
    }
  }

  return merged
}
