/**
 * Icon Collection Utilities
 *
 * Extracts icon references from ProseMirror content during build.
 * This enables:
 * - Preloading hints for faster icon loading
 * - Build-time validation (warn about missing icons)
 * - Tooling support (see which icons are used)
 *
 * Icons are stored as image nodes with:
 * - role: "icon"
 * - library: "lu" (or "lucide", "hi", etc.)
 * - name: "house" (icon name)
 */

/**
 * Map friendly family names to short codes (react-icons format)
 * Same mapping as runtime/content-reader for consistency
 */
const FAMILY_MAP = {
  lucide: 'lu',
  heroicons: 'hi',
  heroicons2: 'hi2',
  phosphor: 'pi',
  tabler: 'tb',
  feather: 'fi',
  fa: 'fa',
  fa6: 'fa6',
  bootstrap: 'bs',
  'material-design': 'md',
  'ant-design': 'ai',
  remix: 'ri',
  'simple-icons': 'si',
  vscode: 'vsc',
  weather: 'wi',
  game: 'gi',
  // Direct codes map to themselves
  lu: 'lu',
  hi: 'hi',
  hi2: 'hi2',
  pi: 'pi',
  tb: 'tb',
  fi: 'fi',
  bs: 'bs',
  md: 'md',
  ai: 'ai',
  ri: 'ri',
  si: 'si',
  vsc: 'vsc',
  wi: 'wi',
  gi: 'gi'
}

/**
 * Normalize a library name to its short code
 * @param {string} library - Library name (e.g., "lucide" or "lu")
 * @returns {string} Short code (e.g., "lu")
 */
function normalizeLibrary(library) {
  return FAMILY_MAP[library?.toLowerCase()] || library?.toLowerCase() || null
}

/**
 * Walk a ProseMirror document and collect icon references
 *
 * @param {Object} doc - ProseMirror document
 * @param {Function} visitor - Callback for each icon: (library, name) => void
 */
export function walkContentIcons(doc, visitor) {
  if (!doc) return

  // Check for image nodes with role="icon"
  if (doc.type === 'image' && doc.attrs?.role === 'icon') {
    const { library, name } = doc.attrs
    if (library && name) {
      visitor(library, name)
    }
  }

  // Recurse into content
  if (doc.content && Array.isArray(doc.content)) {
    doc.content.forEach(child => walkContentIcons(child, visitor))
  }
}

/**
 * Collect all icon references from a section's content
 *
 * @param {Object} section - Section object with content
 * @param {string} sourcePath - Path to source file (for bySource tracking)
 * @returns {Object} Icon collection result
 *   - icons: Set of normalized icon references (e.g., "lu:house")
 *   - bySource: Map of icon references to source files
 */
export function collectSectionIcons(section, sourcePath) {
  const icons = new Set()
  const bySource = new Map()

  if (section.content) {
    walkContentIcons(section.content, (library, name) => {
      const normalizedLibrary = normalizeLibrary(library)
      if (!normalizedLibrary) return

      const iconRef = `${normalizedLibrary}:${name}`
      icons.add(iconRef)

      // Track which files use this icon
      if (!bySource.has(iconRef)) {
        bySource.set(iconRef, [])
      }
      bySource.get(iconRef).push(sourcePath)
    })
  }

  return { icons, bySource }
}

/**
 * Merge multiple icon collection results
 *
 * @param {...Object} collections - Icon collection results
 * @returns {Object} Merged collection
 */
export function mergeIconCollections(...collections) {
  const merged = {
    icons: new Set(),
    bySource: new Map()
  }

  for (const collection of collections) {
    if (!collection) continue

    // Merge icons set
    if (collection.icons) {
      collection.icons.forEach(icon => merged.icons.add(icon))
    }

    // Merge bySource map
    if (collection.bySource) {
      for (const [iconRef, sources] of collection.bySource) {
        if (!merged.bySource.has(iconRef)) {
          merged.bySource.set(iconRef, [])
        }
        merged.bySource.get(iconRef).push(...sources)
      }
    }
  }

  return merged
}

/**
 * Build icon manifest from collected icons
 *
 * @param {Object} iconCollection - Merged icon collection
 * @returns {Object} Icon manifest for site-content.json
 */
export function buildIconManifest(iconCollection) {
  const { icons, bySource } = iconCollection

  // Get unique families used
  const families = new Set()
  for (const iconRef of icons) {
    const [family] = iconRef.split(':')
    families.add(family)
  }

  // Convert bySource Map to plain object for JSON serialization
  const bySourceObj = {}
  for (const [iconRef, sources] of bySource) {
    bySourceObj[iconRef] = [...new Set(sources)] // dedupe sources
  }

  return {
    used: [...icons].sort(),
    families: [...families].sort(),
    bySource: bySourceObj,
    count: icons.size
  }
}
