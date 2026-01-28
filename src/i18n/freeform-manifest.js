/**
 * Free-form Translation Manifest Management
 *
 * Tracks source content hashes for free-form translations to detect
 * when source content changes (staleness). The manifest lives at:
 *   locales/freeform/{locale}/.manifest.json
 *
 * Manifest format:
 * {
 *   "pages/about/hero.md": { "hash": "a1b2c3d4", "recorded": "2025-01-28" },
 *   "page-ids/installation/intro.md": { "hash": "b2c3d4e5", "recorded": "2025-01-25" },
 *   "collections/articles/getting-started.md": { "hash": "c3d4e5f6", "recorded": "2025-01-27" }
 * }
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'

const MANIFEST_FILENAME = '.manifest.json'

/**
 * Compute a hash of a ProseMirror document for staleness detection
 *
 * Extracts text content and computes a hash that changes when
 * the content changes (ignoring formatting-only changes).
 *
 * @param {Object} doc - ProseMirror document
 * @returns {string} 8-character hex hash
 */
export function computeSourceHash(doc) {
  if (!doc) return ''

  // Extract all text content from the document
  const textContent = extractTextFromDoc(doc)

  // Hash the normalized text
  return createHash('sha256')
    .update(textContent)
    .digest('hex')
    .slice(0, 8)
}

/**
 * Recursively extract text from a ProseMirror document
 * @param {Object} node - ProseMirror node
 * @returns {string} Concatenated text content
 */
function extractTextFromDoc(node) {
  if (!node) return ''

  if (node.type === 'text') {
    return node.text || ''
  }

  if (!node.content || !Array.isArray(node.content)) {
    return ''
  }

  return node.content.map(extractTextFromDoc).join(' ')
}

/**
 * Get the manifest path for a locale
 * @param {string} localeDir - Path to locale's freeform directory
 * @returns {string} Path to manifest file
 */
function getManifestPath(localeDir) {
  return join(localeDir, MANIFEST_FILENAME)
}

/**
 * Load the manifest for a locale
 *
 * @param {string} localeDir - Path to locale's freeform directory (locales/freeform/{locale})
 * @returns {Promise<Object>} Manifest object (empty if not found)
 */
export async function loadManifest(localeDir) {
  const manifestPath = getManifestPath(localeDir)

  if (!existsSync(manifestPath)) {
    return {}
  }

  try {
    const content = await readFile(manifestPath, 'utf-8')
    return JSON.parse(content)
  } catch (err) {
    console.warn(`[i18n] Failed to load manifest ${manifestPath}: ${err.message}`)
    return {}
  }
}

/**
 * Save the manifest for a locale
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {Object} manifest - Manifest object to save
 */
export async function saveManifest(localeDir, manifest) {
  const manifestPath = getManifestPath(localeDir)

  // Ensure directory exists
  if (!existsSync(localeDir)) {
    await mkdir(localeDir, { recursive: true })
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

/**
 * Record a source hash in the manifest
 *
 * Called when a new free-form translation is created to record
 * the hash of the source content at that time.
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {string} relativePath - Path relative to locale dir (e.g., 'pages/about/hero.md')
 * @param {string} sourceHash - Hash of the source content
 * @returns {Promise<void>}
 */
export async function recordHash(localeDir, relativePath, sourceHash) {
  const manifest = await loadManifest(localeDir)

  manifest[relativePath] = {
    hash: sourceHash,
    recorded: new Date().toISOString().split('T')[0] // YYYY-MM-DD
  }

  await saveManifest(localeDir, manifest)
}

/**
 * Check if a translation is stale (source content changed)
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {string} relativePath - Path relative to locale dir
 * @param {string} currentSourceHash - Current hash of source content
 * @returns {Promise<Object>} { isStale, recordedHash, recordedDate, currentHash }
 */
export async function checkStaleness(localeDir, relativePath, currentSourceHash) {
  const manifest = await loadManifest(localeDir)
  const entry = manifest[relativePath]

  if (!entry) {
    // No recorded hash - translation was never registered
    return {
      isStale: false, // Not stale, just unregistered
      isNew: true,
      recordedHash: null,
      recordedDate: null,
      currentHash: currentSourceHash
    }
  }

  const isStale = entry.hash !== currentSourceHash

  return {
    isStale,
    isNew: false,
    recordedHash: entry.hash,
    recordedDate: entry.recorded,
    currentHash: currentSourceHash
  }
}

/**
 * Update the hash for a translation (after translator reviews changes)
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {string} relativePath - Path relative to locale dir
 * @param {string} newHash - New hash to record
 * @returns {Promise<void>}
 */
export async function updateHash(localeDir, relativePath, newHash) {
  return recordHash(localeDir, relativePath, newHash)
}

/**
 * Remove entries from the manifest
 *
 * Used when translations are deleted.
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {string[]} paths - Paths to remove
 * @returns {Promise<number>} Number of entries removed
 */
export async function removeManifestEntries(localeDir, paths) {
  const manifest = await loadManifest(localeDir)
  let removed = 0

  for (const path of paths) {
    if (manifest[path]) {
      delete manifest[path]
      removed++
    }
  }

  if (removed > 0) {
    await saveManifest(localeDir, manifest)
  }

  return removed
}

/**
 * Rename entries in the manifest
 *
 * Used when translations are moved/renamed.
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {string[]} oldPaths - Old paths
 * @param {string[]} newPaths - New paths (same order as oldPaths)
 * @returns {Promise<number>} Number of entries renamed
 */
export async function renameManifestEntries(localeDir, oldPaths, newPaths) {
  if (oldPaths.length !== newPaths.length) {
    throw new Error('oldPaths and newPaths must have the same length')
  }

  const manifest = await loadManifest(localeDir)
  let renamed = 0

  for (let i = 0; i < oldPaths.length; i++) {
    const oldPath = oldPaths[i]
    const newPath = newPaths[i]

    if (manifest[oldPath]) {
      manifest[newPath] = manifest[oldPath]
      delete manifest[oldPath]
      renamed++
    }
  }

  if (renamed > 0) {
    await saveManifest(localeDir, manifest)
  }

  return renamed
}

/**
 * Get all stale translations for a locale
 *
 * Compares manifest hashes against current source content.
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {Object} sourceHashes - Map of relativePath → currentHash
 * @returns {Promise<Object[]>} Array of { path, recordedHash, recordedDate, currentHash }
 */
export async function getStaleTranslations(localeDir, sourceHashes) {
  const manifest = await loadManifest(localeDir)
  const stale = []

  for (const [path, entry] of Object.entries(manifest)) {
    const currentHash = sourceHashes[path]

    // If we have a current hash and it differs, it's stale
    if (currentHash && currentHash !== entry.hash) {
      stale.push({
        path,
        recordedHash: entry.hash,
        recordedDate: entry.recorded,
        currentHash
      })
    }
  }

  return stale
}

/**
 * Get orphaned translations (translations without source)
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {Set<string>} validPaths - Set of valid translation paths that have source content
 * @returns {Promise<Object[]>} Array of { path, recordedHash, recordedDate }
 */
export async function getOrphanedTranslations(localeDir, validPaths) {
  const manifest = await loadManifest(localeDir)
  const orphaned = []

  for (const [path, entry] of Object.entries(manifest)) {
    if (!validPaths.has(path)) {
      orphaned.push({
        path,
        recordedHash: entry.hash,
        recordedDate: entry.recorded
      })
    }
  }

  return orphaned
}

/**
 * Get unregistered translations (translations without manifest entry)
 *
 * @param {string} localeDir - Path to locale's freeform directory
 * @param {string[]} translationPaths - All translation file paths found
 * @returns {Promise<string[]>} Paths that exist as files but not in manifest
 */
export async function getUnregisteredTranslations(localeDir, translationPaths) {
  const manifest = await loadManifest(localeDir)
  return translationPaths.filter(path => !manifest[path])
}
