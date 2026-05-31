// Site-content projection — write a site-content document back to a site's
// config + content files. The inverse of site.js (siteProjectToDocument).
//
// The site-content document is one entity with an `info` brief plus `pages`,
// `layout_sections`, `extensions`, and `collections` sections. This module
// inverts it onto the file surface:
//
//   - `info`        → site.yml / theme.yml / head.html        (siteInfoToConfig)
//   - `extensions`  → site.yml::extensions                    (siteInfoToConfig)
//   - `pages`       → pages/**                                (siteContentDocumentToProject)
//   - `layout_sections` → layout/**                           (siteContentDocumentToProject)
//   - `collections` → collections.yml                         (collections-project)
//
// Authored files stay clean: section files are `<stableId>.md`; section order +
// nesting live in `page.yml::sections:` (the nested-array form); NO backend uuid
// is written into `page.yml` or the `.md` files. The stableId is user-facing (URL
// hash targets) and must survive round trips, so it is the filename and the
// primary match key. The backend's per-item uuids are kept in a gitignored
// `.uniweb/pull-index.json` (a `uuid → relative path` map) — see readPullIndex.
//
// Reconcile (opt-in `prune`): write the incoming set, then DELETE files/dirs that
// no longer correspond to any incoming item (git-pull-like). Matching is by
// stableId, with the `.uniweb/` uuid index as the rename anchor: when an item's
// uuid now sits at a DIFFERENT path than the index recorded, its file
// (`<stableId>.md`) or directory is RENAMED in place — a git-mv-style move — so an
// app-side rename is minimal churn, not a delete + recreate. The index is a
// disposable optimization: without it, pull falls back to stableId matching plus
// git's own content-based rename detection. Content-similarity matching (for items
// with no uuid) is a later fallback.
//
// Localized fields (`name`, `description`) are wired as `{ <locale>: value }`;
// we unwrap to the source locale for the file surface (other locales stay in
// the i18n pipeline). Absent `info` keys are left untouched on disk.

import { join, relative, extname, basename } from 'node:path'
import { readFileSync, existsSync, unlinkSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import yaml from 'js-yaml'
import { writeSiteConfig, writeThemeFile, writeIfChanged, writeSectionFile, writeYamlFile } from './project-writer.js'
import { unwrapLocalized } from './backfill.js'
import { LOCALIZED_FIELD_ASSUMPTION } from './localize.js'

// The pull-side identity index: a per-clone, GITIGNORED `uuid → relative path`
// map under `.uniweb/`, the home for the backend's per-item identity so that
// authored files (`page.yml`, section `.md`) stay clean. It exists ONLY to anchor
// rename detection on the next pull (a uuid that now sits at a different path was
// moved/renamed → relocate it in place rather than delete + recreate). It is a
// disposable optimization: delete it and the next pull simply falls back to
// stableId matching (+ git's own rename detection), so it never blocks anything.
const PULL_INDEX_RELPATH = join('.uniweb', 'pull-index.json')

function readPullIndex(siteRoot) {
  try {
    const o = JSON.parse(readFileSync(join(siteRoot, PULL_INDEX_RELPATH), 'utf8'))
    return o && o.items && typeof o.items === 'object' ? o.items : {}
  } catch {
    return {} // missing / unreadable → no anchors, fall back to stableId matching
  }
}

function writePullIndex(siteRoot, items) {
  writeIfChanged(join(siteRoot, PULL_INDEX_RELPATH), JSON.stringify({ version: 1, items }, null, 2) + '\n')
}

// Rename `<from>` to `<to>` in place when both differ, the source exists, and the
// target is free (a collision falls back to write-new + prune-old). Records the
// move so callers can report it.
function renameInPlace(from, to, report) {
  if (from === to || !existsSync(from) || existsSync(to)) return false
  renameSync(from, to)
  report.renamed.push({ from, to })
  return true
}

// Place the item identified by `uuid` at `targetAbs`: if the index recorded it at
// a different path, relocate it there first (git-mv-style), then record its new
// path in the fresh index. No-op without a ctx (standalone callers / no uuid).
function placeByUuid(ctx, uuid, targetAbs) {
  if (!ctx || !uuid) return
  const oldRel = ctx.oldIndex[uuid]
  if (oldRel) renameInPlace(join(ctx.siteRoot, oldRel), targetAbs, ctx.report)
  ctx.newIndex[uuid] = relative(ctx.siteRoot, targetAbs)
}

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

// ---------------------------------------------------------------------------
// Section records → section .md files
// ---------------------------------------------------------------------------

/**
 * Re-inline a section's extracted insets back into its ProseMirror content —
 * the exact inverse of content-collector's `extractInsets`. The producer pulls
 * each `![alt](@Component){params}` ref out of the body into an `insets[]` array
 * and leaves an `inset_placeholder` behind; content-writer only serializes
 * `inset_ref` nodes, so we restore them before serializing or the inset would
 * be reported as unmappable and dropped.
 *
 * @param {object} content - the section's ProseMirror document (placeholders in)
 * @param {Array} insets - `[{ refId, type, params, title, embedKind }]`
 * @returns {object} a content document with `inset_ref` nodes restored
 */
function reinlineInsets(content, insets) {
  if (!content || !Array.isArray(content.content) || !Array.isArray(insets) || insets.length === 0) {
    return content
  }
  const byRef = new Map(insets.map((i) => [i.refId, i]))

  const visit = (nodes) =>
    nodes.map((node) => {
      if (!node) return node
      if (node.type === 'inset_placeholder') {
        const inset = byRef.get(node.attrs?.refId)
        if (!inset) return node // no match → leave the placeholder (the guard reports it)
        const attrs = { component: inset.type, ...(inset.params || {}) }
        if (inset.title != null) attrs.alt = inset.title
        // `visual` is the extractor's default — omit it so the projected markdown
        // doesn't gain a spurious `{embedKind=visual}` the source never had.
        if (inset.embedKind && inset.embedKind !== 'visual') attrs.embedKind = inset.embedKind
        return { type: 'inset_ref', attrs }
      }
      if (Array.isArray(node.content)) return { ...node, content: visit(node.content) }
      return node
    })

  return { ...content, content: visit(content.content) }
}

/**
 * Project one section `$`-record (from `page_sections` / `layout_sections`) to a
 * section `.md` file — the inverse of site.js `mapSectionData`. Frontmatter is
 * `type` + the flat `params` + `background` / `theme` (`theme_override`) /
 * `preset` / `input` / `fetch` / `id` (`stable_id`); the body is the section's
 * content (insets re-inlined) serialized to markdown. Idempotent.
 *
 * Note: `$children` (the `@`-nested child sections) are NOT written here — the
 * page walk places them as `@`-files plus a `nest:` map. This writes one section.
 *
 * @param {object} params
 * @param {string} params.filePath
 * @param {object} params.record - a section `$`-record
 * @returns {'updated'|'unchanged'}
 */
export function sectionRecordToFile({ filePath, record }) {
  const { type, stable_id, preset, input, params, content, insets, fetch, background, theme_override } = record || {}

  const frontmatter = {}
  if (type !== undefined) frontmatter.type = type
  if (params && typeof params === 'object') Object.assign(frontmatter, params)
  if (background !== undefined) frontmatter.background = background
  if (theme_override !== undefined) frontmatter.theme = theme_override
  if (preset !== undefined) frontmatter.preset = preset
  if (input !== undefined) frontmatter.input = input
  if (fetch !== undefined) frontmatter.fetch = fetch
  if (stable_id !== undefined) frontmatter.id = stable_id

  const body = insets ? reinlineInsets(content, insets) : content
  return writeSectionFile({ filePath, content: body, params: frontmatter })
}

// ---------------------------------------------------------------------------
// Pages tree → pages/**  (+ layout_sections → layout/**)
// ---------------------------------------------------------------------------

// A section/page record's durable handle: the `stable_id` content field (which
// survives the round trip), falling back to the `$id` transport handle.
function recordStableId(record) {
  return record?.stable_id || record?.$id || null
}

/**
 * Write a page's `page_sections` tree to clean `<stableId>.md` files in `pageDir`
 * and return the `page.yml::sections:` array that captures order + nesting — the
 * verified nested form (`processExplicitSections`): a string per leaf section, a
 * single-key object `{ <stableId>: [children…] }` per nested one. No numeric or
 * `@` prefixes — `sections:` is the canonical projected form.
 *
 * @param {object} params
 * @param {string} params.pageDir
 * @param {object[]} params.pageSections - the page's section `$`-records
 * @param {object} [params.ctx] - projection context `{ siteRoot, oldIndex,
 *        newIndex, report }`; enables uuid-anchored relocation + index recording.
 * @returns {{ sections: Array, written: string[] }}
 */
export function pageSectionsToFiles({ pageDir, pageSections, ctx }) {
  const written = []
  const buildEntries = (records) => {
    const entries = []
    for (const record of records || []) {
      const stableId = recordStableId(record)
      if (!stableId) continue // anonymous and id-less → cannot place; skip
      const filePath = join(pageDir, `${stableId}.md`)
      // If this uuid's section moved (an app-side stableId rename), relocate its
      // `.md` in place before writing; then record its current path in the index.
      placeByUuid(ctx, record.$uuid, filePath)
      sectionRecordToFile({ filePath, record })
      written.push(filePath)
      const children = Array.isArray(record.$children) ? record.$children : []
      entries.push(children.length > 0 ? { [stableId]: buildEntries(children) } : stableId)
    }
    return entries
  }
  return { sections: buildEntries(pageSections), written }
}

// Inverse of site.js buildPageData → the `page.yml` / `folder.yml` object.
// `slug`/`mode`/`is_dynamic`/`param_name` are NOT keys here — they shape the
// directory (name, page.yml vs folder.yml, `[param]/`), not the config body.
// Identity (the backend uuid) is NOT written here — it lives in the gitignored
// `.uniweb/` index so authored files stay clean.
function pageRecordToYml(record, sectionsArray, sourceLocale) {
  const y = {}
  if (record.stable_id !== undefined) y.id = record.stable_id
  const title = unwrapLocalized(record.title, sourceLocale)
  if (title !== undefined) y.title = title
  const description = unwrapLocalized(record.description, sourceLocale)
  if (description !== undefined) y.description = description
  const label = unwrapLocalized(record.label, sourceLocale)
  if (label !== undefined) y.label = label
  if (record.keywords !== undefined) y.keywords = record.keywords
  if (record.is_index) y.index = true
  if (record.hidden !== undefined) y.hidden = record.hidden
  if (record.hide_in_header !== undefined) y.hideInHeader = record.hide_in_header
  if (record.hide_in_footer !== undefined) y.hideInFooter = record.hide_in_footer
  if (record.redirect !== undefined) y.redirect = record.redirect
  if (record.rewrite !== undefined) y.rewrite = record.rewrite
  if (record.layout !== undefined) y.layout = record.layout
  if (record.seo !== undefined) y.seo = record.seo
  if (record.fetch !== undefined) y.fetch = record.fetch
  if (sectionsArray && sectionsArray.length > 0) y.sections = sectionsArray
  return y
}

// Delete `<name>.md` files in `pageDir` whose stableId isn't in `keep`.
function pruneOrphanSectionFiles(pageDir, keep, report) {
  if (!existsSync(pageDir)) return
  for (const entry of readdirSync(pageDir)) {
    if (extname(entry).toLowerCase() !== '.md') continue
    if (keep.has(basename(entry, extname(entry)))) continue
    const p = join(pageDir, entry)
    unlinkSync(p)
    report.deleted.push(p)
  }
}

// Delete subdirectories of `pagesDir` whose name isn't an incoming page dir.
function pruneOrphanPageDirs(pagesDir, keepDirs, report) {
  if (!existsSync(pagesDir)) return
  for (const entry of readdirSync(pagesDir)) {
    const p = join(pagesDir, entry)
    if (!statSync(p).isDirectory() || keepDirs.has(entry)) continue
    rmSync(p, { recursive: true, force: true })
    report.deleted.push(p)
  }
}

// Recursively project the pages tree: a directory per page (slug, or `[param]/`
// for a dynamic page), its `page.yml`/`folder.yml`, its section files, and its
// child pages. Matches incoming items to files by stableId-name (clean overwrite),
// with the `.uniweb/` uuid index as the rename anchor (a uuid now at a new slug →
// the whole page dir is moved in place). When `prune` is set, orphaned section
// files and page dirs are deleted (git-pull-like) — guarded so an EMPTY incoming
// set never nukes an existing level (a malformed/partial payload can't wipe it).
function projectPages(pages, pagesDir, sourceLocale, report, prune, ctx) {
  const incomingDirs = new Set()
  for (const record of pages || []) {
    const dirName = record.is_dynamic ? `[${record.param_name || record.slug}]` : record.slug
    incomingDirs.add(dirName)
    const pageDir = join(pagesDir, dirName)
    // Relocate the whole page dir if this uuid moved to a new slug, then record it.
    placeByUuid(ctx, record.$uuid, pageDir)

    let sectionsArray = []
    let written = []
    if (record.mode === 'page' && Array.isArray(record.page_sections)) {
      const r = pageSectionsToFiles({ pageDir, pageSections: record.page_sections, ctx })
      sectionsArray = r.sections
      written = r.written
      report.sections.push(...r.written)
    }

    const ymlName = record.mode === 'folder' ? 'folder.yml' : 'page.yml'
    const ymlPath = join(pageDir, ymlName)
    writeYamlFile(ymlPath, pageRecordToYml(record, sectionsArray, sourceLocale))
    report.pages.push(ymlPath)

    if (prune && record.mode === 'page') {
      const keep = new Set(written.map((p) => basename(p, extname(p))))
      if (keep.size > 0) pruneOrphanSectionFiles(pageDir, keep, report)
    }

    // Recurse (children || [] so an emptied child level is still visited; the
    // empty-set guard below decides whether to prune it).
    projectPages(record.$children || [], pageDir, sourceLocale, report, prune, ctx)
  }

  if (prune && incomingDirs.size > 0) pruneOrphanPageDirs(pagesDir, incomingDirs, report)
}

// layout_sections → layout/<area>.md (the 'default' layout) or
// layout/<layout_name>/<area>.md. Inverse of site.js collectLayoutNested.
function projectLayout(layoutSections, layoutBaseDir, report) {
  for (const record of layoutSections || []) {
    const area = record.area || recordStableId(record)
    if (!area) continue
    const named = record.layout_name && record.layout_name !== 'default' ? record.layout_name : null
    const filePath = named ? join(layoutBaseDir, named, `${area}.md`) : join(layoutBaseDir, `${area}.md`)
    sectionRecordToFile({ filePath, record })
    report.layout.push(filePath)
  }
}

/**
 * Project a whole `@uniweb/site-content` document to a site's files: `info` →
 * config (siteInfoToConfig), `pages[]` → `pages/**`, `layout_sections` →
 * `layout/**`. Idempotent. Matches by stableId-name (clean overwrite); orphan
 * deletion + content-similarity matching is the reconcile layer.
 *
 * Not yet here: `collections[]` declarations → `collections.yml::collections`
 * (the collection RECORDS are the separate collections lane, collectionsToProject).
 *
 * @param {object} params
 * @param {object} params.document - the `@uniweb/site-content` `$`-document
 * @param {string} params.siteRoot
 * @param {string} [params.sourceLocale]
 * @param {boolean} [params.prune=false] - delete orphaned pages/sections that
 *        have no corresponding incoming item (git-pull-like). Off by default;
 *        `uniweb pull` opts in. Guarded against wiping a level on an empty set.
 * @returns {{ config: object, pages: string[], sections: string[], layout: string[], deleted: string[], renamed: object[] }}
 */
export function siteContentDocumentToProject({ document, siteRoot, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale, prune = false }) {
  const report = { config: null, pages: [], sections: [], layout: [], deleted: [], renamed: [] }
  report.config = siteInfoToConfig({ document, siteRoot, sourceLocale })

  // The uuid identity index (gitignored `.uniweb/`): read the prior map to anchor
  // rename detection, build a fresh one as we project, then persist it. Items not
  // re-projected (deleted) drop out naturally.
  const ctx = { siteRoot, oldIndex: readPullIndex(siteRoot), newIndex: {}, report }

  const paths = document?.info?.paths_config || {}
  const pagesDir = paths.pages ? join(siteRoot, paths.pages) : join(siteRoot, 'pages')
  projectPages(document?.pages, pagesDir, sourceLocale, report, prune, ctx)

  const layoutBaseDir = paths.layout ? join(siteRoot, paths.layout) : join(siteRoot, 'layout')
  projectLayout(document?.layout_sections, layoutBaseDir, report)

  writePullIndex(siteRoot, ctx.newIndex)
  return report
}
