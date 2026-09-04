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
import { readAssetMap, restoreAssetRefs } from './asset-map.js'
import { readFileSync, existsSync, unlinkSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { writeSiteConfig, writeThemeFile, writeIfChanged, writeSectionFile, writeMergedYaml } from './project-writer.js'
import { declarationsToQueriesYml } from './records-project.js'
import { authorableFetch } from '../site/fetch-shapes.js'
import { createTranslationCollector, writeLocaleTranslations, writeFreeformTranslations, unwrapLocalizedContent } from './locale-sync.js'
import { buildFreeformPath } from '../i18n/freeform.js'
import { unwrapLocalized, unwrapLocalizedList } from './backfill.js'
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
  // ⛔ `foundation` is the one entry a caller may SUPPRESS (`keepAuthoredFoundation`),
  // and it is the same principle as restoring authored asset paths below: a round
  // trip must not mangle what the author wrote.
  //
  // The stored value is not always what they wrote. `publish` stamps the RELEASED,
  // version-pinned ref over it, because delivery is version-pinned end to end. Project
  // that straight back into a workspace project and `foundation: src` becomes
  // `@org/x@1.2.3` — which `detectFoundationType` REFUSES for a build (a build is
  // offline and does not guess where a foundation is served), so the project can no
  // longer `build`, `dev` or `export`. Measured 2026-08-19.
  //
  // ⚖️ It is NOT wrong everywhere, which is why this is a caller's decision and not a
  // deletion: a project from `uniweb clone` has no local foundation on disk, and there
  // the pinned ref is exactly what site.yml should say. Only the caller knows which
  // shape it is writing into — and it needs the build's own resolver to know, which is
  // why that check is not made here (it would drag the vite chain into `uwx/`).
  foundation: 'foundation',
  languages: 'languages',
  default_language: 'defaultLanguage',
  // Publish intent — verbatim both ways, dangling codes included (they carry
  // the preserved publish intent of a temporarily-undeclared language).
  publish_languages: 'publishLanguages',
  base: 'base',
  favicon: 'favicon',
  fetcher: 'fetcher',
  build: 'build',
  search: 'search',
  // Safe to project back because nothing STAMPS it: `submit` is authored-only,
  // so a pull can never launder a deploy-derived value into authored config the
  // way a key carried by both would. A host-supplied destination is resolved at
  // render time and never enters `info`.
  submit: 'submit',
  agents: 'agents',
  // Authored-only, like `submit` above — a host's assistant endpoint is offered
  // through `config.services` and resolved at render time, so it never enters
  // `info` and a pull cannot launder it into authored config.
  //
  // ⚠️ Credential-shaped keys are STRIPPED ON PUSH (`stripCredentials`), so the
  // backend never stores one and it cannot come back. What that does to the
  // author's file depends on which direction they are pulling into, and the two
  // differ — ⛔ this comment asserted the wrong one until it was run:
  //
  //   - `pull` over an EXISTING site.yml — the local `apiKey` SURVIVES.
  //     `mergeYamlConfig` spreads one level (`{...existing[key], ...value}`), so
  //     the projected `{endpoint, …}` merges over the local block and nothing
  //     removes a key the document does not carry.
  //   - `clone` into a fresh directory — no local block exists, so the file is
  //     written from the document alone and has no `apiKey`.
  //
  // Both are correct: a pull does not silently delete something the author
  // typed, and the push already warned them. The security property is upheld at
  // the push, not by the pull. Measured end-to-end against a live uniwebd —
  // every unit test passed before and after, so only a real push touched it.
  assistant: 'assistant',
  // Authored-only, like `submit` and `assistant`: a host's tracking endpoint is
  // offered through `config.services.tracking` and resolved at render, so it
  // never enters `info` and a pull cannot launder it into authored config.
  tracking: 'tracking',
  paths: 'paths',
  data: 'data',
  template: 'template',
  seo: 'seo',
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
export function siteInfoToConfig({ document, siteRoot, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale, collector, keepAuthoredFoundation = false }) {
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

  // `keywords` is a localized list (mirrors page keywords) → unwrap to the
  // source locale; the target locales are captured into the locales/ collector.
  if (Array.isArray(info.keywords)) info.keywords.forEach((kw) => collector?.add(kw))
  const keywords = unwrapLocalizedList(info.keywords, sourceLocale)
  if (keywords !== undefined) siteChanges.keywords = keywords

  // Verbatim fields (includes `seo` — the site-level social/SEO block).
  for (const [infoKey, ymlKey] of Object.entries(INFO_TO_SITE_YML)) {
    if (infoKey === 'foundation' && keepAuthoredFoundation) continue
    if (info[infoKey] !== undefined) siteChanges[ymlKey] = info[infoKey]
  }

  // extensions[] → site.yml::extensions. Each entry carries EITHER `ref` (a
  // catalog ref or a local name — an extension is a foundation and is declared
  // like one) OR `url`. Project back whichever is present so a ref survives a
  // pull instead of being dropped or rewritten into a URL. `$id` is the authored
  // declaration and is deliberately NOT used here: after a publish that released
  // a local extension, `ref` is the pinned `@scope/name@version` and is the value
  // the site should now carry.
  const extensions = Array.isArray(document?.extensions)
    ? document.extensions
        .map((e) => (typeof e?.ref === 'string' ? e.ref : e?.url))
        .filter((u) => typeof u === 'string' && u)
    : []
  if (extensions.length > 0) siteChanges.extensions = extensions

  // services[] → site.yml::$services · secrets[] → site.yml::$secrets.
  //
  // ⭐ The `$` prefix, and not the bare name, for the reason spelled out in
  // `uwx/site.js`: `site.yml::services` already means "pretend a host offers these"
  // on the bundle lane, and one key cannot mean two things.
  //
  // ⭐ `$id` is DROPPED — it is derived (a service's `name`; a secret's
  // `service:name` pair), so writing it back would put a redundant handle in the
  // author's file and invite them to edit the one field that must not drift from
  // the fields it is derived from. Same call as `extensions` above.
  //
  // ⛔ Everything else rides VERBATIM, `config` included: it is opaque, per-service
  // and will grow, so projecting a known subset would quietly drop whatever the
  // service gained since this line was written — and the next push would then send
  // the truncated version back as authoritative.
  //
  // ⚠️ An EMPTY section is written as an empty list, not skipped. `[]` is a real
  // state — "this site has no service rows" — and it is the state a `pull` must be
  // able to deliver after the last one was removed. Skipping would leave a stale
  // `$services` on disk that the next push would resurrect.
  for (const [section, ymlKey] of [['services', '$services'], ['secrets', '$secrets']]) {
    const records = document?.[section]
    if (!Array.isArray(records)) continue
    siteChanges[ymlKey] = records.map(({ $id: _id, ...fields }) => fields)
  }

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
 * @param {string} [params.sourceLocale] - locale to unwrap a localized `content`
 *        field to (its source doc → the `.md` body)
 * @param {object} [params.collector] - translation collector; target-locale
 *        structural maps on a localized `content` field are captured into it
 * @returns {'updated'|'unchanged'}
 */
export function sectionRecordToFile({ filePath, record, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale, collector, freeformRelPath }) {
  const { type, stable_id, preset, input, params, content, insets, fetch, background, theme_override } = record || {}

  // A localized `content` field unwraps to the source-locale doc for the body; its
  // target-locale structural maps are captured into the locales/ collector, and any
  // free-form target body is captured with `freeformRelPath` for writing under
  // locales/freeform/. A bare doc (source-only / pre-localization) passes through.
  const sourceContent = unwrapLocalizedContent(content, sourceLocale, collector, freeformRelPath)

  const frontmatter = {}
  if (type !== undefined) frontmatter.type = type
  if (params && typeof params === 'object') Object.assign(frontmatter, params)
  if (background !== undefined) frontmatter.background = background
  if (theme_override !== undefined) frontmatter.theme = theme_override
  if (preset !== undefined) frontmatter.preset = preset
  if (input !== undefined) frontmatter.input = input
  // Invert the build's resolution rather than copy it — see fetch-shapes.js.
  if (fetch !== undefined) frontmatter.fetch = authorableFetch(fetch)
  if (stable_id !== undefined) frontmatter.id = stable_id

  const body = insets ? reinlineInsets(sourceContent, insets) : sourceContent
  return writeSectionFile({ filePath, content: body, params: frontmatter })
}

// ---------------------------------------------------------------------------
// Pages tree → pages/**  (+ layout_sections → layout/**)
// ---------------------------------------------------------------------------

// A section/page record's durable handle: the `stable_id` content field (which
// survives the round trip), falling back to the `$id` transport handle.
export function recordStableId(record) {
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
export function safeStableIdFilename(stableId) {
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
export function pageSectionsToFiles({ pageDir, pageSections, ctx, pageContext }) {
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
      // The free-form translation path for this section (locale-independent); a
      // target-locale free-form body is written under locales/freeform/{locale}/here.
      const freeformRelPath = pageContext
        ? buildFreeformPath({ stableId }, pageContext)
        : null
      sectionRecordToFile({ filePath, record, sourceLocale: ctx?.sourceLocale, collector: ctx?.collector, freeformRelPath })
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
  'hideIn', 'knowledge', 'trackSections', 'redirect', 'rewrite', 'layout', 'seo',
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
  if (record.keywords !== undefined) y.keywords = unwrapLocalizedList(record.keywords, sourceLocale)
  if (record.is_index) y.index = true
  if (record.hidden !== undefined) y.hidden = record.hidden
  if (record.hide_in !== undefined) y.hideIn = record.hide_in
  if (record.knowledge !== undefined) y.knowledge = record.knowledge
  // Wire snake_case → authored camelCase, the same crossing `hide_in` → `hideIn`
  // makes two lines up. ⛔ Both directions or neither: a page prop that pushes
  // and does not pull is WORSE than one that does neither, because the author's
  // flag is silently removed from their `page.yml` the first time they run
  // `uniweb pull`.
  if (record.track_sections !== undefined) y.trackSections = record.track_sections
  if (record.redirect !== undefined) y.redirect = record.redirect
  if (record.rewrite !== undefined) y.rewrite = record.rewrite
  if (record.layout !== undefined) y.layout = record.layout
  if (record.seo !== undefined) y.seo = record.seo
  // Invert the build's resolution rather than copy it — see fetch-shapes.js.
  if (record.fetch !== undefined) y.fetch = authorableFetch(record.fetch)
  // `sections:` exists to preserve ORDER and NESTING, which the projected filenames
  // can't carry (they're `<stableId>.md`, with no numeric prefix). It must not also
  // decide MEMBERSHIP — and a bare list does: the collector reads a list without
  // `...` as strict, "only listed sections processed". So a pulled page silently
  // excluded any section added afterwards. You'd create the file, push, and be told
  // "nothing to push", with nothing anywhere explaining why.
  //
  // The trailing `...` makes it inclusive: listed sections keep their order and
  // their nesting, and anything new is discovered and appended as it would be in a
  // page that was never pulled.
  if (sectionsArray && sectionsArray.length > 0) y.sections = [...sectionsArray, '...']
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
  if (prune) prunePagesTree(pages, pagesDir, sourceLocale, report)
}

// The directory name for a page record (slug, or `[param]/` for a dynamic page).
// `slug` is a localized `{lang: value}` map on the wire (a page route stays
// localized); the directory uses the canonical SOURCE-locale slug. `param_name`
// is already a plain string.
export function pageDirName(record, sourceLocale) {
  const slug = unwrapLocalized(record.slug, sourceLocale)
  if (!record.is_dynamic) return slug
  // The multi-segment folder rides the wire as slug `...path` with
  // `param_name: slug` (the handle it delivers by); it comes back as the one
  // fixed spelling, never as `[slug]`.
  if (slug === '...path') return '[...path]'
  return `[${record.param_name || slug}]`
}

// Pass 1 — write + relocate every page dir, its page.yml/folder.yml, and its
// section files, recursing into children. No deletes happen here. `routePrefix`
// accumulates the slug-path route (for the free-form translation path; matches the
// producer's slugPath, normalizeRouteForPath strips any leading slash on both).
function writePagesTree(pages, pagesDir, sourceLocale, report, ctx, routePrefix = '') {
  for (const record of pages || []) {
    const slug = unwrapLocalized(record.slug, sourceLocale) // localized {lang:value} → canonical
    const pageDir = join(pagesDir, pageDirName(record, sourceLocale))
    // Relocate the whole page dir if this uuid moved to a new slug, then record it.
    placeByUuid(ctx, record.$uuid, pageDir)

    // Capture target-locale translations of the page's localized scalars; the
    // source value goes inline into page.yml below (pageRecordToYml unwraps it).
    ctx.collector?.add(record.title)
    ctx.collector?.add(record.label)
    ctx.collector?.add(record.description)
    // keywords is a localized ARRAY — capture each element's target locales.
    if (Array.isArray(record.keywords)) record.keywords.forEach((kw) => ctx.collector?.add(kw))
    else ctx.collector?.add(record.keywords)

    const route = routePrefix ? `${routePrefix}/${slug}` : slug
    const pageContext = { route, id: record.stable_id }

    let sectionsArray = []
    if (record.mode === 'page' && Array.isArray(record.page_sections)) {
      const r = pageSectionsToFiles({ pageDir, pageSections: record.page_sections, ctx, pageContext })
      sectionsArray = r.sections
      report.sections.push(...r.written)
    }

    const ymlName = record.mode === 'folder' ? 'folder.yml' : 'page.yml'
    const ymlPath = join(pageDir, ymlName)
    // Merge (not full-dump) so author-added keys survive a pull; the projector
    // owns only PAGE_YML_MANAGED_KEYS.
    writeMergedYaml(ymlPath, pageRecordToYml(record, sectionsArray, sourceLocale), PAGE_YML_MANAGED_KEYS)
    report.pages.push(ymlPath)

    writePagesTree(record.$children || [], pageDir, sourceLocale, report, ctx, route)
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
function prunePagesTree(pages, pagesDir, sourceLocale, report) {
  const incomingDirs = new Set()
  for (const record of pages || []) {
    incomingDirs.add(pageDirName(record, sourceLocale))
    const pageDir = join(pagesDir, pageDirName(record, sourceLocale))
    if (record.mode === 'page') {
      const keep = collectSectionFileBases(record.page_sections)
      if (keep.size > 0) pruneOrphanSectionFiles(pageDir, keep, report)
    }
    prunePagesTree(record.$children || [], pageDir, sourceLocale, report)
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
    sectionRecordToFile({ filePath, record, sourceLocale: ctx?.sourceLocale, collector: ctx?.collector })
    report.layout.push(filePath)
    written.push(filePath)
  }
  if (prune && written.length > 0) pruneOrphanLayout(layoutBaseDir, new Set(written), report)
}

/**
 * Project a whole `@uniweb/site-content` document to a site's files: `info` →
 * config (siteInfoToConfig), `collections[]` declarations →
 * `collections.yml::collections` (declarationsToQueriesYml), `pages[]` →
 * `pages/**`, `layout_sections` → `layout/**`. Idempotent. Matches by
 * stableId-name (clean overwrite); orphan deletion + content-similarity matching
 * is the reconcile layer.
 *
 * The collection RECORDS are the separate collections lane (recordsToProject);
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
export function siteContentDocumentToProject({ document, siteRoot, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale, prune = false, keepAuthoredFoundation = false }) {
  const report = { config: null, collections: null, locales: null, assets: null, pages: [], sections: [], layout: [], deleted: [], renamed: [] }

  // Collects target-locale translations of localized scalars as they're projected;
  // flushed to locales/{locale}.json at the end (the manifest stays derivable).
  const collector = createTranslationCollector(sourceLocale)

  // Put the author's own asset paths back before anything is serialized. Stored
  // content carries an id and a serve URL; only the committed map knows the ref
  // the author wrote. Without this a push/pull cycle rewrites every image in a
  // developer's source to a backend route — a mangling of files they own, by a
  // round trip that changed nothing.
  report.assets = restoreAssetRefs(document, readAssetMap(siteRoot))

  report.config = siteInfoToConfig({ document, siteRoot, sourceLocale, collector, keepAuthoredFoundation })
  report.queries = declarationsToQueriesYml({ document, siteRoot })

  // The uuid identity index (gitignored `.uniweb/`): read the prior map to anchor
  // rename detection, build a fresh one as we project, then persist it. Items not
  // re-projected (deleted) drop out naturally. `collector` rides along to capture
  // localized scalars during the page walk.
  const ctx = { siteRoot, oldIndex: readPullIndex(siteRoot), newIndex: {}, report, collector, sourceLocale }

  const paths = document?.info?.paths || {}
  const pagesDir = paths.pages ? join(siteRoot, paths.pages) : join(siteRoot, 'pages')
  projectPages(document?.pages, pagesDir, sourceLocale, report, prune, ctx)

  const layoutBaseDir = paths.layout ? join(siteRoot, paths.layout) : join(siteRoot, 'layout')
  projectLayout(document?.layout_sections, layoutBaseDir, report, prune, ctx)

  report.locales = writeLocaleTranslations(siteRoot, collector.byLocale)
  // Target-locale FREE-FORM bodies → locales/freeform/{locale}/<relpath> + manifest.
  report.freeform = writeFreeformTranslations(siteRoot, collector.freeformPending)
  writePullIndex(siteRoot, ctx.newIndex)
  return report
}
