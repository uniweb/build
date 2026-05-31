// Site-content projection — write a site-content document back to a site's
// config + content files. The inverse of site.js (siteProjectToDocument).
//
// The site-content document is one entity with an `info` brief plus `pages`,
// `layout_sections`, `extensions`, and `collections` sections. This module
// inverts it onto the file surface:
//
//   - `info`        → site.yml / theme.yml / head.html        (siteInfoToConfig)
//   - `extensions`  → site.yml::extensions                    (siteInfoToConfig)
//   - `pages`       → pages/**                                (later increment)
//   - `layout_sections` → layout/**                           (later increment)
//   - `collections` → collections.yml                         (collections-project)
//
// This increment lands the config half (`info` + `extensions`) — the bounded,
// decision-light slice that reuses the project-writer's config merges. The
// pages/layout tree (section files, `nest:` reconstruction, dynamic-route
// folders, and stableId identity-matching) is the larger surface and lands
// next.
//
// Localized fields (`name`, `description`) are wired as `{ <locale>: value }`;
// we unwrap to the source locale for the file surface (other locales stay in
// the i18n pipeline). Absent `info` keys are left untouched on disk — a pull
// doesn't churn config it didn't carry, and deletion is out of scope here.

import { join } from 'node:path'
import { writeSiteConfig, writeThemeFile, writeIfChanged } from './project-writer.js'
import { unwrapLocalized } from './backfill.js'
import { LOCALIZED_FIELD_ASSUMPTION } from './localize.js'

// info field → site.yml key. Plain (non-localized, verbatim) mappings.
const INFO_TO_SITE_YML = {
  foundation_name: 'foundation',
  locales: 'languages',
  default_locale: 'defaultLanguage',
  base_path: 'base',
  fetcher_config: 'fetcher',
  build_options: 'build',
  search_config: 'search',
  paths_config: 'paths',
  data_config: 'data',
}

/**
 * Project a site-content document's `info` (+ `extensions`) onto the site's
 * config files: `site.yml`, `theme.yml`, and `head.html`. Idempotent; only the
 * keys the document carries are written (absent keys are left as-is on disk).
 *
 * @param {object} params
 * @param {object} params.document - the `@uniweb/site-content` `$`-document
 *        (`{ info, extensions?, … }`)
 * @param {string} params.siteRoot
 * @param {string} [params.sourceLocale] - locale to unwrap localized fields to
 * @returns {{ siteConfig: string, theme?: string, headHtml?: string }} per-file
 *          write status ('updated' | 'unchanged')
 */
export function siteInfoToConfig({ document, siteRoot, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale }) {
  const info = document?.info || {}

  const siteChanges = {}
  // Localized text fields → unwrapped to the source locale.
  const name = unwrapLocalized(info.name, sourceLocale)
  if (name !== undefined) siteChanges.name = name
  const description = unwrapLocalized(info.description, sourceLocale)
  if (description !== undefined) siteChanges.description = description

  // Verbatim fields.
  for (const [infoKey, ymlKey] of Object.entries(INFO_TO_SITE_YML)) {
    if (info[infoKey] !== undefined) siteChanges[ymlKey] = info[infoKey]
  }

  // extensions[] (each `{ $id: url, url }`) → site.yml::extensions (url list).
  const extensions = Array.isArray(document?.extensions)
    ? document.extensions.map((e) => e?.url).filter((u) => typeof u === 'string')
    : []
  if (extensions.length > 0) siteChanges.extensions = extensions

  const result = { siteConfig: writeSiteConfig(siteRoot, siteChanges) }

  // theme (whole object) → theme.yml.
  if (info.theme && typeof info.theme === 'object') {
    result.theme = writeThemeFile(siteRoot, info.theme)
  }

  // head_html → head.html (a raw file, not YAML).
  if (info.head_html != null) {
    result.headHtml = writeIfChanged(join(siteRoot, 'head.html'), info.head_html)
  }

  return result
}
