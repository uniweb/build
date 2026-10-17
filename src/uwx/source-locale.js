/**
 * ⭐ THE LANGUAGE A SITE IS WRITTEN IN — the locale every localized value of it is keyed by on the
 * sync wire, its source. One rule for both directions, `resolveDefaultLocale`
 * (`@uniweb/core/locale-config`): `defaultLanguage`, else the first of `languages`, else `en`.
 *
 * - From the files, `site.yml` (`siteSourceLocale`): what a push wraps pages, records and folder
 *   labels under.
 * - From a document, its `settings` (`documentSourceLocale`): what a pull unwraps them by, and what
 *   keys a document's units. A push sends `default_language` when the site names one, and its
 *   `languages` source first (`uwx/site.js`), so the rule over a document gives back the language
 *   the push wrapped it in.
 *
 * ⛔ Until 2026-10-16 only the page push asked the site. The record push and every pull assumed
 * `en`, which every site measured until then happened to be written in: a French site with an
 * English translation came back from a pull in English, its own text filed as a translation of it;
 * a French-only clone came back with empty sections; and its records were pushed labelled English,
 * their English translations left out.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { resolveDefaultLocale } from '@uniweb/core/locale-config'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'

/**
 * The language a site's files are written in — `site.yml`'s, by the shared rule.
 *
 * @param {string} siteRoot - the directory holding `site.yml`
 * @returns {string}
 */
export function siteSourceLocale(siteRoot) {
  const path = join(siteRoot, 'site.yml')
  let siteYml = null
  if (existsSync(path)) {
    try {
      siteYml = yaml.load(readFileSync(path, 'utf8'), YAML_OPTIONS)
    } catch {
      siteYml = null // an unreadable site.yml is reported by whoever reads it for more
    }
  }
  return resolveDefaultLocale(siteYml && typeof siteYml === 'object' ? siteYml : {})
}

/**
 * The language a `@uniweb/site-content` document's localized values are keyed by — its
 * `settings`, by the shared rule.
 *
 * @param {object} document - the site-content `$`-document
 * @returns {string}
 */
export function documentSourceLocale(document) {
  const settings = document?.settings
  return resolveDefaultLocale({
    defaultLanguage: settings?.default_language,
    languages: settings?.languages,
  })
}
