/**
 * @uniweb/build i18n module
 *
 * Site content internationalization utilities.
 *
 * Usage:
 *   import { extractManifest, syncManifest, mergeLocale } from '@uniweb/build/i18n'
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

import { computeHash, normalizeText } from './hash.js'
import { extractTranslatableContent } from './extract.js'
import { syncManifests, formatSyncReport } from './sync.js'
import { mergeTranslations, generateAllLocales } from './merge.js'

export {
  // Hash utilities
  computeHash,
  normalizeText,

  // Core functions
  extractTranslatableContent,
  syncManifests,
  formatSyncReport,
  mergeTranslations,
  generateAllLocales
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
 * @returns {Object} Map of locale to output path
 */
export async function buildLocalizedContent(siteRoot, options = {}) {
  const {
    localesDir = DEFAULTS.localesDir,
    locales = [],
    outputDir = join(siteRoot, 'dist'),
    fallbackToSource = true
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

    // Write to locale subdirectory
    const localeOutputDir = join(outputDir, locale)
    if (!existsSync(localeOutputDir)) {
      await mkdir(localeOutputDir, { recursive: true })
    }

    const outputPath = join(localeOutputDir, 'site-content.json')
    await writeFile(outputPath, JSON.stringify(translated, null, 2))

    outputs[locale] = outputPath
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
