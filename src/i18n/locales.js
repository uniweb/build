// ⭐ WHICH LOCALES A SITE HAS — one rule, for the build and for the push.
//
// An explicit `languages:` list is the set, as written. `'*'`, or no `languages:` at all, is every
// translation file in the locales directory. ⛔ Until 2026-09-25 the push read an explicit
// `languages:` alone, so a site whose set comes from its files — the `international` template,
// which has none — was pushed as a one-language site, and none of its translations left the
// machine, while the build of the same site produced every one of them.
//
// A leaf, with nothing but `node:fs` and core's locale rules (a leaf too) beneath it, so the sync
// lane can use it without pulling in the rest of the i18n module.

import { existsSync, readdirSync } from 'node:fs'
import { normalizeLanguageList, resolveDefaultLocale } from '@uniweb/core/locale-config'

// Files in the locales directory that are not a locale's translations.
export const KEPT_FILE = '_kept.json'
export const RESERVED_LOCALE_FILES = new Set(['manifest.json', '_memory.json', KEPT_FILE])

/**
 * The locales a directory holds translations for — one per `<locale>.json` — sorted.
 *
 * @param {string} localesPath
 * @returns {string[]}
 */
export function availableLocales(localesPath) {
  if (!existsSync(localesPath)) return []
  try {
    return readdirSync(localesPath)
      .filter((f) => f.endsWith('.json') && !RESERVED_LOCALE_FILES.has(f))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
  } catch {
    return []
  }
}

/**
 * A site's locales, from its `languages:` and its locales directory.
 *
 * - `['es', 'fr']` → those, as written (an entry may be `{ code, label }`)
 * - `'*'`, a list holding `'*'`, or nothing → every locale the directory holds
 *
 * @param {string[]|string|undefined} configLocales - `site.yml::languages`
 * @param {string} localesPath
 * @returns {string[]}
 */
export function resolveLocaleList(configLocales, localesPath) {
  if (Array.isArray(configLocales) && configLocales.length > 0) {
    if (configLocales.includes('*')) return availableLocales(localesPath)
    return configLocales.map((l) => (typeof l === 'string' ? l : l.code))
  }
  return availableLocales(localesPath)
}

/**
 * The languages a build makes pages in besides its default: the site's locales
 * (`resolveLocaleList`), only those `publishLanguages:` lists when it lists any, never the default,
 * which is the root tree. One rule for `uniweb build`, which makes each one's pages, and for the
 * bundle, which processes the files their translations name (`site/plugin.js`), so the second
 * never processes for a language the first does not make, nor misses one it does.
 *
 * @param {Object} siteConfig - `site.yml`, as written
 * @param {string} localesPath - the locales directory
 * @returns {{ locales: string[], skipped: string[], defaultLocale: string }} the languages a build
 *   makes, and those `publishLanguages:` leaves out
 */
export function localesToBuild(siteConfig, localesPath) {
  const config = siteConfig || {}
  let locales = resolveLocaleList(config.languages, localesPath)
  let skipped = []
  if (config.publishLanguages != null) {
    const publish = new Set(normalizeLanguageList(config.publishLanguages))
    skipped = locales.filter((l) => !publish.has(l))
    locales = locales.filter((l) => publish.has(l))
  }
  const defaultLocale = resolveDefaultLocale(config)
  return { locales: locales.filter((l) => l !== defaultLocale), skipped, defaultLocale }
}
