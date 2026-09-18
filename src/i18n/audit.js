/**
 * Audit translations for stale and missing entries
 *
 * Compares locale translation files against the manifest to identify:
 * - Valid: translations that match current manifest entries
 * - Missing: manifest entries without translations
 * - Stale: translations for content that no longer exists
 */

import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Inline markdown → ProseMirror, so the markup check asks the merge's own question
// ("would this value produce marks?") instead of pattern-matching markdown syntax.
// Same lazy-import-with-fallback pattern as merge.js / extract.js.
let markdownToProseMirror
try {
  const contentReader = await import('@uniweb/content-reader')
  markdownToProseMirror = contentReader.markdownToProseMirror
} catch {
  markdownToProseMirror = null
}

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
  const losesMarkup = []

  // Check manifest entries
  for (const hash of manifestHashes) {
    if (translationHashes.has(hash)) {
      const unit = manifest.units[hash]
      const source = unit.source
      const translation = getTranslationText(translations[hash])
      valid.push({ hash, source, translation })

      // ⭐ The source element carries inline markdown; the translation does not.
      // `merge` builds the translated element from the VALUE alone — it never
      // re-applies marks from the source — so this entry will render as flat prose
      // and its links will be gone. It still counts as translated, which is why
      // coverage cannot see it: the whole class scores 100%.
      // ⛔ REPLACES a `<N>`-tag check that could no longer fire. Those tags were the
      // pre-2026-06-24 keying scheme (`d12d594`); extraction has not emitted one
      // since, so the check was dead while looking like a live guard — and it was
      // the only thing in the pipeline that even gestured at mark fidelity.
      if (unit.markup && translation.length > 0 && !carriesInlineMarkup(translation)) {
        losesMarkup.push({ hash, source, markup: unit.markup, translation })
      }
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
    stale,
    losesMarkup
  }
}

/**
 * Does this translation value produce any inline marks when the merge parses it?
 *
 * Asks the parser rather than a regex: the merge resolves a value through
 * `markdownToProseMirror`, so the only honest test of "will this keep its link"
 * is to run the same conversion. With no converter available the check declines
 * to fire — a missing dependency must not invent findings.
 */
function carriesInlineMarkup(value) {
  if (!markdownToProseMirror) return true
  try {
    const doc = markdownToProseMirror(value)
    const walk = (nodes) =>
      (nodes || []).some(
        (n) => (n?.marks && n.marks.length > 0) || (n?.type && n.type !== 'text' && n.type !== 'paragraph') || walk(n?.content)
      )
    return walk(doc?.content)
  } catch {
    return true
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
    if (result.losesMarkup?.length > 0) {
      lines.push(`  Loses markup: ${result.losesMarkup.length}  (links/bold in the source, plain in the translation)`)
    }

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

    if (verbose && result.losesMarkup?.length > 0) {
      lines.push(`\n  Translations that drop the source's inline markup:`)
      lines.push(`  (a translation value is inline markdown — copy the links and marks across)`)
      for (const entry of result.losesMarkup.slice(0, 10)) {
        lines.push(`    - ${entry.hash}`)
        lines.push(`        source: "${truncate(entry.markup, 60)}"`)
        lines.push(`        yours:  "${truncate(entry.translation, 60)}"`)
      }
      if (result.losesMarkup.length > 10) {
        lines.push(`    ... and ${result.losesMarkup.length - 10} more`)
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
