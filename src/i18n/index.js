/**
 * @uniweb/build i18n module
 *
 * Site content internationalization utilities.
 *
 * Usage:
 *   import { extractManifest, syncManifest, mergeLocale } from '@uniweb/build/i18n'
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { computeHash, normalizeText } from './hash.js'
import { availableLocales, resolveLocaleList } from './locales.js'
import { extractTranslatableContent } from './extract.js'
import { syncManifests, formatSyncReport } from './sync.js'
import { mergeTranslations, generateAllLocales } from './merge.js'
import { auditLocale, cleanLocale, formatAuditReport } from './audit.js'
import {
  extractRecordContent,
  buildLocalizedRecords,
  getRecordLocales,
  translateRecordData,
  RECORD_LOCALES_DIR
} from './records.js'
import { resolveDefaultLocale } from '@uniweb/core'
import { generateSearchIndex } from '@uniweb/projections'
import { searchDeclaredOn } from '../site/search-declared.js'

// Free-form translation support
import {
  loadFreeformTranslation,
  loadFreeformRecord,
  discoverFreeformTranslations,
  getFreeformFileMeta,
  parseFreeformPath,
  buildFreeformPath,
  freeformPathsFor,
  freeformSourceIndex,
  buildFreeformRecordPath
} from './freeform.js'
import {
  computeSourceHash,
  loadManifest as loadFreeformManifest,
  saveManifest as saveFreeformManifest,
  recordHash,
  checkStaleness,
  updateHash,
  removeManifestEntries,
  renameManifestEntries,
  getStaleTranslations,
  getOrphanedTranslations,
  getUnregisteredTranslations
} from './freeform-manifest.js'

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
  extractRecordContent,
  buildLocalizedRecords,
  getRecordLocales,
  translateRecordData,
  RECORD_LOCALES_DIR,

  // Locale resolution
  getAvailableLocales,
  resolveLocales,

  // Free-form translation functions
  loadFreeformTranslation,
  loadFreeformRecord,
  discoverFreeformTranslations,
  getFreeformFileMeta,
  parseFreeformPath,
  buildFreeformPath,
  freeformPathsFor,
  freeformSourceIndex,
  buildFreeformRecordPath,

  // Free-form manifest functions
  computeSourceHash,
  loadFreeformManifest,
  saveFreeformManifest,
  recordHash,
  checkStaleness,
  updateHash,
  removeManifestEntries,
  renameManifestEntries,
  getStaleTranslations,
  getOrphanedTranslations,
  getUnregisteredTranslations
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

/**
 * Get available locales by scanning the locales directory for *.json files
 * @param {string} localesPath - Path to locales directory
 * @returns {Promise<string[]>} Array of locale codes found
 */
async function getAvailableLocales(localesPath) {
  return availableLocales(localesPath)
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
  // The one rule, shared with the push (`uwx/site.js`) — see `./locales.js`.
  return resolveLocaleList(configLocales, localesPath)
}

/**
 * Extract manifest from site content and write to file
 * @param {string} siteRoot - Site root directory
 * @param {Object} siteContent - Collected site content (from collectSiteContent)
 * @param {Object} options - Options
 * @returns {Object} { manifest, report }
 */
export async function extractManifest(siteRoot, siteContent, options = {}) {
  const {
    localesDir = DEFAULTS.localesDir,
    verbose = false,
    dryRun = false
  } = options

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

  // Write new manifest (skip in dry-run mode)
  if (!dryRun) {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  }

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
export async function extractRecordManifest(siteRoot, options = {}) {
  const { localesDir = DEFAULTS.localesDir, dryRun = false } = options

  // Extract translatable content from collections
  const manifest = await extractRecordContent(siteRoot)

  // Ensure collections locales directory exists
  const recordLocalesDir = join(siteRoot, localesDir, RECORD_LOCALES_DIR)
  if (!existsSync(recordLocalesDir)) {
    await mkdir(recordLocalesDir, { recursive: true })
  }

  const manifestPath = join(recordLocalesDir, 'manifest.json')

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

  // Write new manifest (skip in dry-run mode)
  if (!dryRun) {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
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
 * ⭐ THE LOCALE SET A PAYLOAD DECLARES — resolved here, because this is the only
 * place that knows it.
 *
 * ⛔ THE BUILD AND THE RUNTIME USED TO DISAGREE ABOUT WHERE LOCALES COME FROM, and
 * nothing failed when they did. The build derives them from the FILESYSTEM —
 * every `locales/*.json`, which is also what `languages: '*'` means — while
 * `Website.buildLocalesList` reads `config.languages` and nothing else. So a site
 * with locale files and no `languages:` in `site.yml` built a complete
 * `dist/<locale>/` tree whose Website reported `hasMultipleLocales() === false`.
 *
 * Everything gated on that answer then silently switched off, in the rendered
 * output, with no warning anywhere:
 *   - no link was locale-prefixed (`applyLocale`, @uniweb/kit/utils/href) — every
 *     internal link on a French page pointed into the English tree;
 *   - no route translation was applied, although the build had emitted the
 *     translated routes as directories (`/fr/a-propos/` existed; nothing linked
 *     to it);
 *   - any foundation UI gated on `hasMultipleLocales()` — the language switcher —
 *     vanished from the very pages that needed it.
 *
 * Measured 2026-09-18 on our own `international` template, which was in exactly
 * this state. ⇒ **The producer stamps what it resolved; the consumer reads it.**
 * Guessing the set twice, from two different sources, is what this replaces.
 *
 * Declared entries are kept as authored — a `{ code, label }` object carries a
 * label the filesystem cannot know — and resolved codes are appended.
 */
function declaredLanguages(config, defaultLocale, locales) {
  const authored = Array.isArray(config?.languages) ? config.languages : []
  const codeOf = (e) => (typeof e === 'string' ? e : e?.code)
  const seen = new Set(authored.map(codeOf).filter(Boolean))
  const out = authored.filter((e) => codeOf(e) && codeOf(e) !== '*')
  for (const code of [defaultLocale, ...locales]) {
    if (code && !seen.has(code)) {
      seen.add(code)
      out.push(code)
    }
  }
  return out
}

/**
 * Build translated site content for all locales
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @param {boolean} [options.generateSearchIndexes=true] - Generate search indexes for each locale
 * @param {boolean} [options.freeformEnabled=true] - Enable free-form translation support
 * @returns {Object} Map of locale to output paths
 */
export async function buildLocalizedContent(siteRoot, options = {}) {
  const {
    localesDir = DEFAULTS.localesDir,
    locales = [],
    outputDir = join(siteRoot, 'dist'),
    fallbackToSource = true,
    generateSearchIndexes = true,
    freeformEnabled = true
  } = options

  const localesPath = join(siteRoot, localesDir)

  // Load source site content
  const siteContentPath = join(outputDir, 'site-content.json')
  const siteContentRaw = await readFile(siteContentPath, 'utf-8')
  const siteContent = JSON.parse(siteContentRaw)
  const defaultLocale = resolveDefaultLocale(siteContent.config)

  const outputs = {}

  // ⭐ The DEFAULT locale's payload needs the same stamp. It is not written in
  // this loop — it is the source this function reads — but a visitor landing on
  // `/` gets a Website built from it, and without the set that page loses its
  // language switcher while every translated page has one.
  const stampedLanguages = declaredLanguages(siteContent.config, defaultLocale, locales)
  if (JSON.stringify(siteContent.config?.languages) !== JSON.stringify(stampedLanguages)) {
    siteContent.config = { ...siteContent.config, languages: stampedLanguages }
    await writeFile(siteContentPath, JSON.stringify(siteContent, null, 2))
  }

  for (const locale of locales) {
    // ⛔ THE DEFAULT LOCALE IS THE ROOT TREE, NEVER A SUBDIRECTORY. Emitting
    // `dist/<default>/` mints a byte-identical duplicate of every page at a second
    // URL — duplicate content on any real domain, and the `hreflang` block already
    // points that locale at `/` (`locale.default`, site/plugin.js) so nothing links
    // to the copy.
    //
    // ⚠️ It was reachable only through the DECLARED form, which is the form the
    // contract tells authors to use: `resolveLocales` returns an explicit
    // `languages: [en, fr]` verbatim, default included, while the wildcard and
    // filesystem forms exclude it by accident (there is no `locales/en.json`). So
    // the documented spelling was the broken one. `uniweb i18n generate` has always
    // skipped the default explicitly; this is the same rule, one stage later.
    // Measured 2026-09-18: 47 pages duplicated under /en/.
    if (locale === defaultLocale) continue

    const localePath = join(localesPath, `${locale}.json`)

    // Load translations (or empty object if not exists)
    let translations = {}
    if (existsSync(localePath)) {
      const localeRaw = await readFile(localePath, 'utf-8')
      translations = JSON.parse(localeRaw)
    }

    // Check if free-form translations exist for this locale
    const freeformDir = join(localesPath, 'freeform', locale)
    const hasFreeform = freeformEnabled && existsSync(freeformDir)

    // Merge translations (with free-form support if enabled)
    let translated
    if (hasFreeform) {
      // Use async merge with free-form support
      translated = await mergeTranslations(siteContent, translations, {
        fallbackToSource,
        locale,
        localesDir: localesPath,
        freeformEnabled: true
      })

      // Check for stale/orphaned free-form translations and warn
      await warnAboutFreeformIssues(locale, freeformDir, siteContent)
    } else {
      // Use sync merge (original behavior)
      translated = mergeTranslations(siteContent, translations, {
        fallbackToSource
      })
    }

    // Mark the active locale in the translated content, and stamp the resolved
    // locale set so the runtime does not have to re-derive it — see
    // `declaredLanguages`.
    translated.config = {
      ...translated.config,
      activeLocale: locale,
      languages: declaredLanguages(siteContent.config, defaultLocale, locales)
    }

    // Write to locale subdirectory
    const localeOutputDir = join(outputDir, locale)
    if (!existsSync(localeOutputDir)) {
      await mkdir(localeOutputDir, { recursive: true })
    }

    const contentOutputPath = join(localeOutputDir, 'site-content.json')
    await writeFile(contentOutputPath, JSON.stringify(translated, null, 2))

    outputs[locale] = { content: contentOutputPath }

    // Generate search index for this locale if search is enabled
    if (generateSearchIndexes && searchDeclaredOn(translated)) {
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
 * Check for stale/orphaned free-form translations and emit warnings
 * @param {string} locale - Locale code
 * @param {string} freeformDir - Path to locale's freeform directory
 * @param {Object} siteContent - Site content for building source hashes
 */
async function warnAboutFreeformIssues(locale, freeformDir, siteContent) {
  try {
    // Every path the renderer reads a section's translation from, for every section it
    // translates, with the hash of each source — the index the CLI's free-form commands
    // judge by too (`freeformSourceIndex`).
    const { validPaths, sourceHashes, canJudge } = freeformSourceIndex(siteContent)

    // Check for stale translations
    const stale = await getStaleTranslations(freeformDir, sourceHashes)
    for (const item of stale) {
      console.warn(`[i18n] Free-form translation stale: ${locale}/${item.path} (source changed ${item.recordedDate})`)
    }

    // Check for orphaned translations — only those this content can judge: never a
    // record's (`records/…`), which is read from records the site content does not hold.
    const orphaned = await getOrphanedTranslations(freeformDir, validPaths)
    for (const item of orphaned) {
      if (!canJudge(item.path)) continue
      console.warn(`[i18n] Free-form translation orphaned: ${locale}/${item.path}`)
    }

    // Check for unregistered translations (new files)
    const discovered = await discoverFreeformTranslations(locale, dirname(dirname(freeformDir)))
    const allPaths = [...discovered.pages, ...discovered.pageIds, ...discovered.records]
    const unregistered = await getUnregisteredTranslations(freeformDir, allPaths)
    for (const path of unregistered) {
      // Auto-register new free-form translations
      const sourcePath = validPaths.has(path) ? path : null
      if (sourcePath && sourceHashes[sourcePath]) {
        await recordHash(freeformDir, path, sourceHashes[sourcePath])
        console.log(`[i18n] Free-form translation registered: ${locale}/${path} (new file)`)
      }
    }
  } catch (err) {
    // Non-fatal: just log and continue
    console.warn(`[i18n] Could not check free-form translation status for ${locale}: ${err.message}`)
  }
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
