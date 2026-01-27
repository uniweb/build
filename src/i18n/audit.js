/**
 * Audit translations for stale and missing entries
 *
 * Compares locale translation files against the manifest to identify:
 * - Valid: translations that match current manifest entries
 * - Missing: manifest entries without translations
 * - Stale: translations for content that no longer exists
 */

import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Audit a locale file against the manifest
 * @param {string} localesPath - Path to locales directory
 * @param {string} locale - Locale code (e.g., 'es')
 * @returns {Promise<Object>} Audit result { locale, exists, total, valid, missing, stale }
 */
export async function auditLocale(localesPath, locale) {
  const manifestPath = join(localesPath, 'manifest.json')
  const localePath = join(localesPath, `${locale}.json`)

  if (!existsSync(manifestPath)) {
    throw new Error('Manifest not found. Run "uniweb i18n extract" first.')
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
  const manifestHashes = new Set(Object.keys(manifest.units))

  // Handle missing locale file
  if (!existsSync(localePath)) {
    return {
      locale,
      exists: false,
      total: manifestHashes.size,
      valid: [],
      missing: [...manifestHashes],
      stale: []
    }
  }

  const translations = JSON.parse(await readFile(localePath, 'utf-8'))
  const translationHashes = new Set(Object.keys(translations))

  const valid = []
  const missing = []
  const stale = []

  // Check manifest entries
  for (const hash of manifestHashes) {
    if (translationHashes.has(hash)) {
      valid.push({
        hash,
        source: manifest.units[hash].source,
        translation: getTranslationText(translations[hash])
      })
    } else {
      missing.push({
        hash,
        source: manifest.units[hash].source,
        field: manifest.units[hash].field,
        contexts: manifest.units[hash].contexts
      })
    }
  }

  // Check for stale entries (in translations but not in manifest)
  for (const hash of translationHashes) {
    if (!manifestHashes.has(hash)) {
      stale.push({
        hash,
        translation: getTranslationText(translations[hash])
      })
    }
  }

  return {
    locale,
    exists: true,
    total: manifestHashes.size,
    valid,
    missing,
    stale
  }
}

/**
 * Get translation text (handles string or object with default/overrides)
 * @param {string|Object} translation - Translation value
 * @returns {string} The translation text
 */
function getTranslationText(translation) {
  if (typeof translation === 'string') return translation
  if (typeof translation === 'object' && translation !== null) {
    if (translation.default) return translation.default
  }
  return String(translation)
}

/**
 * Remove stale entries from a locale file
 * @param {string} localesPath - Path to locales directory
 * @param {string} locale - Locale code
 * @param {string[]} staleHashes - Hashes to remove
 * @returns {Promise<number>} Number of entries removed
 */
export async function cleanLocale(localesPath, locale, staleHashes) {
  const localePath = join(localesPath, `${locale}.json`)

  if (!existsSync(localePath)) {
    return 0
  }

  const translations = JSON.parse(await readFile(localePath, 'utf-8'))

  let removed = 0
  for (const hash of staleHashes) {
    if (hash in translations) {
      delete translations[hash]
      removed++
    }
  }

  if (removed > 0) {
    await writeFile(localePath, JSON.stringify(translations, null, 2))
  }

  return removed
}

/**
 * Format audit results for console output
 * @param {Object[]} results - Array of audit results from auditLocale
 * @param {Object} options - Formatting options
 * @param {boolean} [options.verbose=false] - Show stale entry details
 * @returns {string} Formatted report
 */
export function formatAuditReport(results, options = {}) {
  const { verbose = false } = options
  const lines = []

  for (const result of results) {
    lines.push(`\n${result.locale}:`)

    if (!result.exists) {
      lines.push(`  No translation file`)
      lines.push(`  ${result.total} strings need translation`)
      continue
    }

    const coverage = result.total > 0
      ? Math.round((result.valid.length / result.total) * 100)
      : 100

    lines.push(`  Valid:   ${result.valid.length} (${coverage}%)`)
    lines.push(`  Missing: ${result.missing.length}`)
    lines.push(`  Stale:   ${result.stale.length}`)

    if (verbose && result.stale.length > 0) {
      lines.push(`\n  Stale entries:`)
      for (const entry of result.stale.slice(0, 10)) {
        const preview = truncate(entry.translation, 40)
        lines.push(`    - ${entry.hash}: "${preview}"`)
      }
      if (result.stale.length > 10) {
        lines.push(`    ... and ${result.stale.length - 10} more`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * Truncate string for display
 * @param {string} str - String to truncate
 * @param {number} maxLen - Maximum length
 * @returns {string} Truncated string
 */
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}
