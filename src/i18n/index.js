/**
 * @uniweb/build i18n module
 *
 * Site content internationalization utilities.
 *
 * Usage:
 *   import { extractManifest, syncManifest, mergeLocale } from '@uniweb/build/i18n'
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

import { computeHash, normalizeText } from './hash.js'
import { extractTranslatableContent } from './extract.js'
import { syncManifests, formatSyncReport } from './sync.js'
import { mergeTranslations, generateAllLocales } from './merge.js'
import { auditLocale, cleanLocale, formatAuditReport } from './audit.js'
import {
  extractCollectionContent,
  buildLocalizedCollections,
  getCollectionLocales,
  COLLECTIONS_DIR
} from './collections.js'
import { generateSearchIndex, isSearchEnabled } from '../search/index.js'

export {
  // Hash utilities
  computeHash,
  normalizeText,

  // Core functions
  extractTranslatableContent,
  syncManifests,
  formatSyncReport,
  mergeTranslations,
  generateAllLocales,

  // Audit functions
  auditLocale,
  cleanLocale,
  formatAuditReport,

  // Collection functions
  extractCollectionContent,
  buildLocalizedCollections,
  getCollectionLocales,
  COLLECTIONS_DIR,

  // Locale resolution
  getAvailableLocales,
  resolveLocales
}

/**
 * Default paths
 */
const DEFAULTS = {
  localesDir: 'locales',
  manifestFile: 'manifest.json',
  memoryFile: '_memory.json'
}

/**
 * Reserved files in the locales directory (not locale translation files)
 */
const RESERVED_FILES = new Set(['manifest.json', '_memory.json'])

/**
 * Get available locales by scanning the locales directory for *.json files
 * @param {string} localesPath - Path to locales directory
 * @returns {Promise<string[]>} Array of locale codes found
 */
async function getAvailableLocales(localesPath) {
  if (!existsSync(localesPath)) {
    return []
  }

  try {
    const files = await readdir(localesPath)
    return files
      .filter(f => f.endsWith('.json') && !RESERVED_FILES.has(f))
      .map(f => f.replace('.json', ''))
      .sort()
  } catch {
    return []
  }
}

/**
 * Resolve locales configuration to actual locale list
 *
 * Handles:
 * - undefined → all available locales (from locales/*.json)
 * - '*' → explicitly all available locales
 * - ['es', 'fr'] → only those specific locales
 *
 * @param {string[]|string|undefined} configLocales - Locales from config
 * @param {string} localesPath - Path to locales directory
 * @returns {Promise<string[]>} Resolved array of locale codes
 */
async function resolveLocales(configLocales, localesPath) {
  // Explicit list of locales
  if (Array.isArray(configLocales) && configLocales.length > 0) {
    // Check for '*' in array (e.g., locales: ['*'])
    if (configLocales.includes('*')) {
      return getAvailableLocales(localesPath)
    }
    return configLocales
  }

  // String value '*' means all available
  if (configLocales === '*') {
    return getAvailableLocales(localesPath)
  }

  // undefined, null, or empty array → all available
  return getAvailableLocales(localesPath)
}

/**
 * Extract manifest from site content and write to file
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @returns {Object} { manifest, report }
 */
export async function extractManifest(siteRoot, options = {}) {
  const {
    localesDir = DEFAULTS.localesDir,
    siteContentPath = join(siteRoot, 'dist', 'site-content.json'),
    verbose = false
  } = options

  // Load site content
  const siteContentRaw = await readFile(siteContentPath, 'utf-8')
  const siteContent = JSON.parse(siteContentRaw)

  // Extract translatable content
  const manifest = extractTranslatableContent(siteContent)

  // Ensure locales directory exists
  const localesPath = join(siteRoot, localesDir)
  if (!existsSync(localesPath)) {
    await mkdir(localesPath, { recursive: true })
  }

  // Load previous manifest for comparison
  const manifestPath = join(localesPath, DEFAULTS.manifestFile)
  let previousManifest = null
  if (existsSync(manifestPath)) {
    const prevRaw = await readFile(manifestPath, 'utf-8')
    previousManifest = JSON.parse(prevRaw)
  }

  // Generate sync report
  const report = syncManifests(previousManifest, manifest)

  // Write new manifest
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  if (verbose) {
    console.log(formatSyncReport(report))
    console.log(`\nManifest written to: ${manifestPath}`)
    console.log(`Total units: ${Object.keys(manifest.units).length}`)
  }

  return { manifest, report }
}

/**
 * Extract collection manifest from collection data and write to file
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @returns {Promise<Object>} { manifest, report }
 */
export async function extractCollectionManifest(siteRoot, options = {}) {
  const { localesDir = DEFAULTS.localesDir } = options

  // Extract translatable content from collections
  const manifest = await extractCollectionContent(siteRoot)

  // Ensure collections locales directory exists
  const collectionsDir = join(siteRoot, localesDir, COLLECTIONS_DIR)
  if (!existsSync(collectionsDir)) {
    await mkdir(collectionsDir, { recursive: true })
  }

  const manifestPath = join(collectionsDir, 'manifest.json')

  // Load previous manifest for comparison
  let previousManifest = null
  if (existsSync(manifestPath)) {
    try {
      const prevRaw = await readFile(manifestPath, 'utf-8')
      previousManifest = JSON.parse(prevRaw)
    } catch {
      // Ignore parse errors
    }
  }

  // Generate sync report
  const report = syncManifests(previousManifest, manifest)

  // Write new manifest
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  return { manifest, report }
}

/**
 * Get translation status for all configured locales
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @returns {Object} Status per locale
 */
export async function getTranslationStatus(siteRoot, options = {}) {
  const {
    localesDir = DEFAULTS.localesDir,
    locales = []
  } = options

  const localesPath = join(siteRoot, localesDir)
  const manifestPath = join(localesPath, DEFAULTS.manifestFile)

  if (!existsSync(manifestPath)) {
    throw new Error('Manifest not found. Run extract first.')
  }

  const manifestRaw = await readFile(manifestPath, 'utf-8')
  const manifest = JSON.parse(manifestRaw)
  const totalUnits = Object.keys(manifest.units).length

  const status = {}

  for (const locale of locales) {
    const localePath = join(localesPath, `${locale}.json`)

    if (!existsSync(localePath)) {
      status[locale] = {
        exists: false,
        translated: 0,
        missing: totalUnits,
        coverage: 0
      }
      continue
    }

    const localeRaw = await readFile(localePath, 'utf-8')
    const translations = JSON.parse(localeRaw)
    const translatedHashes = new Set(Object.keys(translations))

    let translated = 0
    let missing = 0

    for (const hash of Object.keys(manifest.units)) {
      if (translatedHashes.has(hash)) {
        translated++
      } else {
        missing++
      }
    }

    status[locale] = {
      exists: true,
      translated,
      missing,
      coverage: totalUnits > 0 ? Math.round((translated / totalUnits) * 100) : 100
    }
  }

  return {
    totalUnits,
    locales: status
  }
}

/**
 * Build translated site content for all locales
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @param {boolean} [options.generateSearchIndex=true] - Generate search indexes for each locale
 * @returns {Object} Map of locale to output paths
 */
export async function buildLocalizedContent(siteRoot, options = {}) {
  const {
    localesDir = DEFAULTS.localesDir,
    locales = [],
    outputDir = join(siteRoot, 'dist'),
    fallbackToSource = true,
    generateSearchIndexes = true
  } = options

  const localesPath = join(siteRoot, localesDir)

  // Load source site content
  const siteContentPath = join(outputDir, 'site-content.json')
  const siteContentRaw = await readFile(siteContentPath, 'utf-8')
  const siteContent = JSON.parse(siteContentRaw)

  const outputs = {}

  for (const locale of locales) {
    const localePath = join(localesPath, `${locale}.json`)

    // Load translations (or empty object if not exists)
    let translations = {}
    if (existsSync(localePath)) {
      const localeRaw = await readFile(localePath, 'utf-8')
      translations = JSON.parse(localeRaw)
    }

    // Merge translations
    const translated = mergeTranslations(siteContent, translations, {
      fallbackToSource
    })

    // Mark the active locale in the translated content
    translated.config = { ...translated.config, activeLocale: locale }

    // Write to locale subdirectory
    const localeOutputDir = join(outputDir, locale)
    if (!existsSync(localeOutputDir)) {
      await mkdir(localeOutputDir, { recursive: true })
    }

    const contentOutputPath = join(localeOutputDir, 'site-content.json')
    await writeFile(contentOutputPath, JSON.stringify(translated, null, 2))

    outputs[locale] = { content: contentOutputPath }

    // Generate search index for this locale if search is enabled
    if (generateSearchIndexes && isSearchEnabled(translated)) {
      const searchConfig = translated.config?.search || {}
      const searchIndex = generateSearchIndex(translated, {
        locale,
        search: searchConfig
      })

      const searchOutputPath = join(localeOutputDir, 'search-index.json')
      await writeFile(searchOutputPath, JSON.stringify(searchIndex, null, 2))

      outputs[locale].searchIndex = searchOutputPath
    }
  }

  return outputs
}

/**
 * Format translation status for console output
 * @param {Object} status - Status from getTranslationStatus
 * @returns {string} Formatted status
 */
export function formatTranslationStatus(status) {
  const lines = [`Translation status (${status.totalUnits} total strings):\n`]

  for (const [locale, info] of Object.entries(status.locales)) {
    if (!info.exists) {
      lines.push(`  ${locale}: No translation file`)
    } else {
      const bar = createProgressBar(info.coverage, 20)
      lines.push(`  ${locale}: ${bar} ${info.coverage}% (${info.translated}/${status.totalUnits})`)
      if (info.missing > 0) {
        lines.push(`       ${info.missing} strings missing`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * Create ASCII progress bar
 */
function createProgressBar(percent, width) {
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']'
}
