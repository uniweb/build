// ⭐ WHICH LOCALES A SITE HAS — one rule, for the build and for the push.
//
// An explicit `languages:` list is the set, as written. `'*'`, or no `languages:` at all, is every
// translation file in the locales directory. ⛔ Until 2026-09-25 the push read an explicit
// `languages:` alone, so a site whose set comes from its files — the `international` template,
// which has none — was pushed as a one-language site, and none of its translations left the
// machine, while the build of the same site produced every one of them.
//
// A leaf, with nothing but `node:fs` beneath it, so the sync lane can use it without pulling in
// the rest of the i18n module.

import { existsSync, readdirSync } from 'node:fs'

// Files in the locales directory that are not a locale's translations.
export const RESERVED_LOCALE_FILES = new Set(['manifest.json', '_memory.json'])

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
