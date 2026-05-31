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
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { writeSiteConfig, writeThemeFile, writeIfChanged, writeSectionFile, writeMergedYaml } from './project-writer.js'
import { declarationsToCollectionsYml } from './collections-project.js'
import { createTranslationCollector, writeLocaleTranslations } from './locale-sync.js'
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

// info field → site.yml key. The backend field names mirror the file keys, so
// most are identity; only `default_language` differs (the file key is camelCase
// `defaultLanguage`).
const INFO_TO_SITE_YML = {
  foundation: 'foundation',
  languages: 'languages',
  default_language: 'defaultLanguage',
  base: 'base',
  favicon: 'favicon',
  fetcher: 'fetcher',
  build: 'build',
  search: 'search',
  paths: 'paths',
  data: 'data',
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
export function siteInfoToConfig({ document, siteRoot, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale, collector }) {
  const info = document?.info || {}

  const siteChanges = {}
  // Localized text fields → unwrapped to the source locale (the target locales are
  // captured into the locales/ collector when one is supplied).
  collector?.add(info.name)
  collector?.add(info.description)
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

  // `info.favicon` rides the verbatim INFO_TO_SITE_YML map above (→ site.yml).
  // `info.assets` is intentionally NOT projected: it is a build-derived upload
  // manifest, not authored config, so a pull never writes it back to the site.

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

// A section's `stable_id` doubles as its `.md` filename. The schema leaves it a
// free string, so an app-set value may carry filesystem-unsafe characters (spaces,
// `/`, …). We DECOUPLE: the file gets a safe name while the true stable_id is kept
// in the section frontmatter `id:` — which the producer reads in preference to the
// filename (content-collector: `stableId = frontmatterId || filenameDerived`), so
// the round trip recovers the real value. A safe stable_id is returned UNCHANGED
// (the common case — byte-for-byte backward compatible). An unsafe one is sanitized
// and given a short hash suffix of the original, so two distinct unsafe ids never
// collide on one filename (a collision would silently drop a section). The
// `page.yml::sections:` leaf uses this same safe base so file resolution matches.
const SAFE_STABLE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
function safeStableIdFilename(stableId) {
  if (SAFE_STABLE_ID.test(stableId)) return stableId
  const base = stableId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const hash = createHash('sha256').update(stableId).digest('hex').slice(0, 6)
  return base ? `${base}-${hash}` : `s-${hash}`
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
      // Filesystem-safe filename (= stableId when already safe); the true stableId
      // rides in frontmatter `id:`. The sections: leaf uses the same base so the
      // producer's filename-based resolution matches.
      const fileBase = safeStableIdFilename(stableId)
      const filePath = join(pageDir, `${fileBase}.md`)
      // If this uuid's section moved (an app-side stableId rename), relocate its
      // `.md` in place before writing; then record its current path in the index.
      placeByUuid(ctx, record.$uuid, filePath)
      sectionRecordToFile({ filePath, record })
      written.push(filePath)
      const children = Array.isArray(record.$children) ? record.$children : []
      entries.push(children.length > 0 ? { [fileBase]: buildEntries(children) } : fileBase)
    }
    return entries
  }
  return { sections: buildEntries(pageSections), written }
}

// Every key pageRecordToYml can emit — the keys the projector OWNS in a
// page.yml/folder.yml. On a merge write these are replaced wholesale (a managed
// key the record no longer carries is dropped); any other key is author-authored
// and preserved. Keep in sync with pageRecordToYml below.
const PAGE_YML_MANAGED_KEYS = new Set([
  'id', 'title', 'description', 'label', 'keywords', 'index', 'hidden',
  'hideInHeader', 'hideInFooter', 'redirect', 'rewrite', 'layout', 'seo',
  'fetch', 'sections',
])

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

// Project the pages tree. TWO PASSES so a section (or page) moved across pages or
// levels is a relocation, not a delete + recreate: pass 1 writes + relocates the
// WHOLE tree (no deletes), pass 2 prunes orphans. If pruning ran inline per page,
// page A's prune would delete a section's file before page B (its new home) got
// to relocate it by uuid — making every cross-page move churn. Deferring prune to
// after the whole tree is relocated keeps the old file alive until its new owner
// claims it (renameInPlace), so pass 2 then sees no orphan.
//
// Matches incoming items to files by stableId-name (clean overwrite), with the
// `.uniweb/` uuid index as the rename anchor. Pruning is guarded so an EMPTY
// incoming level never nukes an existing one (a malformed/partial payload can't
// wipe it).
function projectPages(pages, pagesDir, sourceLocale, report, prune, ctx) {
  writePagesTree(pages, pagesDir, sourceLocale, report, ctx)
  if (prune) prunePagesTree(pages, pagesDir, report)
}

// The directory name for a page record (slug, or `[param]/` for a dynamic page).
function pageDirName(record) {
  return record.is_dynamic ? `[${record.param_name || record.slug}]` : record.slug
}

// Pass 1 — write + relocate every page dir, its page.yml/folder.yml, and its
// section files, recursing into children. No deletes happen here.
function writePagesTree(pages, pagesDir, sourceLocale, report, ctx) {
  for (const record of pages || []) {
    const pageDir = join(pagesDir, pageDirName(record))
    // Relocate the whole page dir if this uuid moved to a new slug, then record it.
    placeByUuid(ctx, record.$uuid, pageDir)

    // Capture target-locale translations of the page's localized scalars; the
    // source value goes inline into page.yml below (pageRecordToYml unwraps it).
    ctx.collector?.add(record.title)
    ctx.collector?.add(record.label)
    ctx.collector?.add(record.description)

    let sectionsArray = []
    if (record.mode === 'page' && Array.isArray(record.page_sections)) {
      const r = pageSectionsToFiles({ pageDir, pageSections: record.page_sections, ctx })
      sectionsArray = r.sections
      report.sections.push(...r.written)
    }

    const ymlName = record.mode === 'folder' ? 'folder.yml' : 'page.yml'
    const ymlPath = join(pageDir, ymlName)
    // Merge (not full-dump) so author-added keys survive a pull; the projector
    // owns only PAGE_YML_MANAGED_KEYS.
    writeMergedYaml(ymlPath, pageRecordToYml(record, sectionsArray, sourceLocale), PAGE_YML_MANAGED_KEYS)
    report.pages.push(ymlPath)

    writePagesTree(record.$children || [], pageDir, sourceLocale, report, ctx)
  }
}

// Every section FILE base in a page's section tree. Nested children are written as
// flat `<base>.md` files in the SAME page dir, so all are kept on prune. Uses the
// safe filename (= stableId when safe) so the keep-set matches the files on disk.
function collectSectionFileBases(pageSections) {
  const bases = new Set()
  const walk = (records) => {
    for (const record of records || []) {
      const id = recordStableId(record)
      if (id) bases.add(safeStableIdFilename(id))
      if (Array.isArray(record.$children)) walk(record.$children)
    }
  }
  walk(pageSections)
  return bases
}

// Pass 2 — prune orphan section files (per page dir) and orphan page dirs (per
// level), AFTER every relocation in pass 1. Guarded against wiping an empty level.
function prunePagesTree(pages, pagesDir, report) {
  const incomingDirs = new Set()
  for (const record of pages || []) {
    incomingDirs.add(pageDirName(record))
    const pageDir = join(pagesDir, pageDirName(record))
    if (record.mode === 'page') {
      const keep = collectSectionFileBases(record.page_sections)
      if (keep.size > 0) pruneOrphanSectionFiles(pageDir, keep, report)
    }
    prunePagesTree(record.$children || [], pageDir, report)
  }
  if (incomingDirs.size > 0) pruneOrphanPageDirs(pagesDir, incomingDirs, report)
}

// The file a layout section maps to: `layout/<area>.md` (the 'default' layout) or
// `layout/<layout_name>/<area>.md`. Inverse of site.js collectLayoutNested.
function layoutFilePath(layoutBaseDir, record) {
  const area = record.area || recordStableId(record)
  if (!area) return null
  const named = record.layout_name && record.layout_name !== 'default' ? record.layout_name : null
  return named ? join(layoutBaseDir, named, `${area}.md`) : join(layoutBaseDir, `${area}.md`)
}

// A layout subdir the producer treats as a named layout (not an `_`-prefixed
// organizational folder, the only thing collectLayoutNested skips).
function isNamedLayoutDir(name) {
  return !name.startsWith('_')
}

// Delete orphan layout `.md` files (default-layout files in layoutBaseDir and
// named-layout files in its subdirs) not in `keep`, and remove a named-layout dir
// left empty. `_`-prefixed organizational folders are never touched.
function pruneOrphanLayout(layoutBaseDir, keep, report) {
  if (!existsSync(layoutBaseDir)) return
  for (const entry of readdirSync(layoutBaseDir)) {
    const p = join(layoutBaseDir, entry)
    const st = statSync(p)
    if (st.isFile()) {
      if (extname(entry).toLowerCase() === '.md' && !keep.has(p)) {
        unlinkSync(p)
        report.deleted.push(p)
      }
    } else if (st.isDirectory() && isNamedLayoutDir(entry)) {
      for (const f of readdirSync(p)) {
        const fp = join(p, f)
        if (statSync(fp).isFile() && extname(f).toLowerCase() === '.md' && !keep.has(fp)) {
          unlinkSync(fp)
          report.deleted.push(fp)
        }
      }
      if (readdirSync(p).length === 0) {
        rmSync(p, { recursive: true, force: true })
        report.deleted.push(p)
      }
    }
  }
}

// Project layout_sections → layout/**. TWO PASSES (like projectPages): pass 1
// writes + relocates each file (uuid-anchored, so an app-side (layout_name, area)
// change is a move, not delete + create); pass 2 prunes orphan files + emptied
// named-layout dirs. Pruning is guarded against an empty incoming set.
function projectLayout(layoutSections, layoutBaseDir, report, prune, ctx) {
  const written = []
  for (const record of layoutSections || []) {
    const filePath = layoutFilePath(layoutBaseDir, record)
    if (!filePath) continue
    placeByUuid(ctx, record.$uuid, filePath)
    sectionRecordToFile({ filePath, record })
    report.layout.push(filePath)
    written.push(filePath)
  }
  if (prune && written.length > 0) pruneOrphanLayout(layoutBaseDir, new Set(written), report)
}

/**
 * Project a whole `@uniweb/site-content` document to a site's files: `info` →
 * config (siteInfoToConfig), `collections[]` declarations →
 * `collections.yml::collections` (declarationsToCollectionsYml), `pages[]` →
 * `pages/**`, `layout_sections` → `layout/**`. Idempotent. Matches by
 * stableId-name (clean overwrite); orphan deletion + content-similarity matching
 * is the reconcile layer.
 *
 * The collection RECORDS are the separate collections lane (collectionsToProject);
 * this writes only their config declarations.
 *
 * @param {object} params
 * @param {object} params.document - the `@uniweb/site-content` `$`-document
 * @param {string} params.siteRoot
 * @param {string} [params.sourceLocale]
 * @param {boolean} [params.prune=false] - delete orphaned pages/sections/layout
 *        files that have no corresponding incoming item (git-pull-like). Off by
 *        default; `uniweb pull` opts in. Guarded against wiping a level on an
 *        empty set.
 * @returns {{ config: object, collections: object, locales: object, pages: string[], sections: string[], layout: string[], deleted: string[], renamed: object[] }}
 */
export function siteContentDocumentToProject({ document, siteRoot, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale, prune = false }) {
  const report = { config: null, collections: null, locales: null, pages: [], sections: [], layout: [], deleted: [], renamed: [] }

  // Collects target-locale translations of localized scalars as they're projected;
  // flushed to locales/{locale}.json at the end (the manifest stays derivable).
  const collector = createTranslationCollector(sourceLocale)

  report.config = siteInfoToConfig({ document, siteRoot, sourceLocale, collector })
  report.collections = declarationsToCollectionsYml({ document, siteRoot })

  // The uuid identity index (gitignored `.uniweb/`): read the prior map to anchor
  // rename detection, build a fresh one as we project, then persist it. Items not
  // re-projected (deleted) drop out naturally. `collector` rides along to capture
  // localized scalars during the page walk.
  const ctx = { siteRoot, oldIndex: readPullIndex(siteRoot), newIndex: {}, report, collector }

  const paths = document?.info?.paths || {}
  const pagesDir = paths.pages ? join(siteRoot, paths.pages) : join(siteRoot, 'pages')
  projectPages(document?.pages, pagesDir, sourceLocale, report, prune, ctx)

  const layoutBaseDir = paths.layout ? join(siteRoot, paths.layout) : join(siteRoot, 'layout')
  projectLayout(document?.layout_sections, layoutBaseDir, report, prune, ctx)

  report.locales = writeLocaleTranslations(siteRoot, collector.byLocale)
  writePullIndex(siteRoot, ctx.newIndex)
  return report
}
