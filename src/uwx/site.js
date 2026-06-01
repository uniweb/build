// Map a file site project to one `@uniweb/site-content` entity, as the
// section-keyed `-document (docs/reference/entity-content.md), then to a
// `subtype: entity` .uwx on the SYNC lane.
//
// SOURCE LAYER: the content-collector's return is flattened and lossy for
// `mode` / `order` / the page tree, so we RE-WALK the source. We reuse
// content-collector's *pure* per-file helpers (markdown→ProseMirror via
// processMarkdownFile, ordering, mode detection) so those semantics stay
// identical to a normal build — only the directory/mode/order *walk* is ours.
//
// The document mirrors the @uniweb/site-content Model: `info` (brief) · `pages`
// (self-nesting; each page carries its `page_sections` as an inline field) ·
// `layout_sections` · `extensions` · `collections`. `info.foundation`
// carries the verbatim `site.yml::foundation` string (the round-trip source of
// truth).
//
// IDENTITY. The ENTITY `$uuid` lives in `site.yml` (top-level `$uuid`); we read it,
// send it, and back-fill the minted value there. Nested pages/sections carry a `$id`
// handle but NO per-item `$uuid` — the backend takes site-content content wholesale
// (collision=force), so there is no per-item uuid round-trip on the wire. For the
// eventual pull, per-item identity is recovered from the in-file `stableId` +
// content-match, not a local id store.
//
// `@`-prefix child sections declared in `page.yml::nest:` ARE reconstructed —
// they ride under their parent section's `$children` (page_sections is
// self_nesting), via the same `processNesting` the normal build uses.
//
// v0 scope (stated, not silent): folder-mode `.md`-as-pages (document/blog-list
// profile), `paths:` mounts, versioned scopes, and media/asset bytes
// (favicon/assets — carried out of band).

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import {
  readYamlFile,
  readFolderConfig,
  isMarkdownFile,
  isChildSection,
  stripAtPrefix,
  isIgnoredFolder,
  parseNumericPrefix,
  compareFilenames,
  parseWildcardArray,
  applyWildcardOrder,
  processMarkdownFile,
} from '../site/content-collector.js'
import { normalizeHideIn } from '../site/nav-visibility.js'
import { emitEntitySyncPackage } from './entity-document.js'
import { LOCALIZED_FIELD_ASSUMPTION } from './localize.js'
import { loadLocaleTranslations, localizeScalar, localizeScalarList, localizeContentDoc, localesDir, isLocalizedContent } from './locale-sync.js'
import { loadFreeformTranslation } from '../i18n/freeform.js'
import { upsertYamlScalar } from './yaml-upsert.js'
import { resolveCollectionsConfig } from './collections-config.js'

const SITE_ENTITY_KEY = 'site-content' // one content entity per site project

function setIf(obj, key, value) {
  if (value !== undefined) obj[key] = value
}

// page_sections and layout_sections share this content shape.
// processMarkdownFile only destructures type/component/preset/input/props/
// fetch/data/id out of frontmatter, so `background:` and `theme:` stay
// inside section.params — lift them into the entity type's dedicated fields.
// Post-pass: wrap every section's `content` (page sections + their `$children`,
// recursing into child pages, plus layout sections) into per-locale form. Mutates
// the records in place. Only called for multi-locale sites. Each target locale is
// either a STRUCTURAL map (from locales/{locale}.json, via localizeContentDoc) or,
// when a FREE-FORM override file exists for that section+locale, the full body
// (loadFreeformTranslation) — the override wins. Async because the free-form read
// hits the filesystem.
async function localizeContentTree(pages, layoutSections, sourceLocale, targetLocales, translations, siteRoot) {
  const freeformBase = localesDir(siteRoot)

  const localizeSection = async (record, page) => {
    if (!record.content) return
    let localized = localizeContentDoc(record.content, sourceLocale, targetLocales, translations)
    if (page) {
      const section = { stableId: record.stable_id || record.$id }
      for (const locale of targetLocales) {
        // loadFreeformTranslation returns { content, frontmatter, … } — the doc is `.content`.
        const body = (await loadFreeformTranslation(section, page, locale, freeformBase))?.content
        if (!body) continue
        // Promote a bare source doc to the localized-map form before adding the
        // override (isLocalizedContent excludes a PM doc, which is also an object).
        if (!isLocalizedContent(localized)) localized = { [sourceLocale]: record.content }
        localized[locale] = body // free-form full body overrides the structural map
      }
    }
    record.content = localized
  }

  const visitSections = async (sections, page) => {
    for (const s of sections || []) {
      await localizeSection(s, page)
      if (Array.isArray(s.$children)) await visitSections(s.$children, page)
    }
  }
  const visitPages = async (pgs, routePrefix) => {
    for (const p of pgs || []) {
      const route = routePrefix ? `${routePrefix}/${p.slug}` : p.slug
      const page = { route, id: p.stable_id }
      if (Array.isArray(p.page_sections)) await visitSections(p.page_sections, page)
      if (Array.isArray(p.$children)) await visitPages(p.$children, route)
    }
  }
  await visitPages(pages, '')
  await visitSections(layoutSections, null) // layout sections have no free-form home
}

function mapSectionData(section) {
  const params = { ...section.params }
  const background = params.background
  const themeOverride = params.theme
  delete params.background
  delete params.theme

  const data = { type: section.type || 'Content' } // entity type requires `type`
  setIf(data, 'stable_id', section.stableId ?? undefined)
  setIf(data, 'preset', section.preset ?? undefined)
  setIf(data, 'input', section.input ?? undefined)
  if (Object.keys(params).length > 0) data.params = params
  data.content = section.content
  if (section.insets && section.insets.length > 0) data.insets = section.insets
  setIf(data, 'fetch', section.fetch ?? undefined)
  setIf(data, 'background', background)
  setIf(data, 'theme_override', themeOverride)
  return data
}

function buildPageData(config, ctx) {
  const { slug, mode, isDynamic, paramName, isRoot, siteIndex, sourceLocale, translations } =
    ctx
  const data = { slug, mode } // both required by the entity type
  setIf(data, 'stable_id', config.id)
  setIf(data, 'title', localizeScalar(config.title, sourceLocale, translations))
  setIf(data, 'description', localizeScalar(config.description, sourceLocale, translations))
  setIf(data, 'label', localizeScalar(config.label, sourceLocale, translations))
  setIf(data, 'keywords', localizeScalarList(config.keywords, sourceLocale, translations))
  const indexed =
    config.index === true || (isRoot && siteIndex && siteIndex === slug)
  if (indexed) data.is_index = true
  setIf(data, 'hidden', config.hidden)
  const hideIn = normalizeHideIn(config)
  if (hideIn.length) data.hide_in = hideIn
  setIf(data, 'redirect', config.redirect)
  setIf(data, 'rewrite', config.rewrite)
  setIf(data, 'layout', config.layout)
  setIf(data, 'seo', config.seo)
  const fetch =
    config.fetch ??
    (config.data
      ? { collection: Array.isArray(config.data) ? config.data[0] : config.data }
      : undefined)
  setIf(data, 'fetch', fetch)
  if (isDynamic) {
    data.is_dynamic = true
    setIf(data, 'param_name', paramName)
  }
  return data
}

async function orderedSubfolders(dirPath, inheritedMode, parentConfig) {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const folders = []
  for (const e of entries) {
    if (!e.isDirectory() || isIgnoredFolder(e.name)) continue
    const path = join(dirPath, e.name)
    const { config, mode, source } = await readFolderConfig(
      path,
      inheritedMode
    )
    folders.push({
      dirName: e.name,
      name: parseNumericPrefix(e.name).name,
      path,
      config,
      internalMode: mode,
      source,
      order: typeof config.order === 'number' ? config.order : undefined,
    })
  }
  // Mirror content-collector's pageFolders sort: explicit order, then
  // numeric-prefix filename order.
  folders.sort(
    (a, b) =>
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      compareFilenames(a.dirName, b.dirName)
  )
  // Then the parent's `pages:` wildcard, exactly as a normal build applies it.
  if (Array.isArray(parentConfig?.pages)) {
    const parsed = parseWildcardArray(parentConfig.pages)
    if (parsed && parsed.mode !== 'all') {
      return applyWildcardOrder(folders, parsed)
    }
  }
  return folders
}

const DYNAMIC_RE = /^\[(.+)\]$/

// ===========================================================================
// NESTED ($-document) lane — Phase 0 de-flatten (bidirectional-sync §8).
//
// The flat `siteProjectToEntity` above emits `items[]` with positional
// `parent_path` tuple-chains (the register lane, package.js). This lane emits the
// section-keyed `$`-document the backend's @uniweb/site-content Model actually
// declares (apps/uniweb-rs/.../system-models/site-content.fixture.yaml) and that
// docs/reference/entity-content.md specifies:
//
//   - `page_sections` is a CHILD section of `pages` → it rides as an INLINE FIELD
//     on each page record (the spec's cross-section rule: "a subsection is an
//     inline field"), NOT a top-level array with a back-reference.
//   - genuine self-nesting uses `$children`: a folder's child pages (within
//     `pages`), and `@`-prefix child sections declared in `nest:` (within
//     `page_sections`). Cross-section parentage is pure structure, never `$parent`.
//   - identity on the wire is `$id` (the stableId — the in-file handle) at every
//     item level, with NO per-item `$uuid` (the entity `$uuid` lives in site.yml;
//     the backend takes site-content content wholesale). See the IDENTITY note in
//     the file header.
//
// v0 deferrals: folder-mode `.md`-as-pages, `paths:` mounts, versioned scopes, and
// media/asset bytes (favicon/assets, carried out of band). `@`-prefix `nest:`
// hierarchy is NOT deferred — it is reconstructed here, same as a normal build.
// ===========================================================================

const SITE_MODEL_NAME = '@uniweb/site-content'

// `$id` (the handle), then the record's fields — the wire's canonical key order.
// `fields` already carries `stable_id` (the Model field); `$id` is the same value.
// Both are kept: `$id` is the sync handle, `stable_id` is the declared content field
// the editor/render reads. No per-item `$uuid` on the wire (see the IDENTITY note in
// the file header) — items are content of the one site-content entity.
function withIdentity(id, fields) {
  return Object.assign({ $id: id }, fields)
}

// One collected section → its `$`-record, recursing `subsections` into `$children`
// (page_sections is self_nesting). `$id` is the section's stableId (rename-stable),
// falling back to a positional handle only for a truly anonymous section.
function sectionToRecord(section, index) {
  const secId = section.stableId || `s${index}`
  const rec = withIdentity(secId, mapSectionData(section))
  if (Array.isArray(section.subsections) && section.subsections.length > 0) {
    rec.$children = section.subsections.map((c, j) => sectionToRecord(c, j))
  }
  return rec
}

// Resolve a section's logical name (`hero`, `card-a`) to its file in `mdFiles`,
// matching the normal build's conventions: bare or `@`-prefixed, with or without
// a numeric `N-` prefix. The stable name is the filename minus `@` and `N-`.
function findSectionFileName(mdFiles, sectionName) {
  for (const file of mdFiles) {
    const bare = stripAtPrefix(parse(file).name)
    if (parseNumericPrefix(bare).name === sectionName) return file
  }
  return null
}

// The content sections under one page, as the inline `page_sections` field.
// Mirrors the normal build's processPage: `@`-prefixed files are children
// (excluded from the top level), `page.yml::nest:` attaches them to their parent
// (recursively), and the resulting subsection tree is emitted via `$children`.
//
// We reconstruct the parent→child tree ourselves (rather than the build's
// `processNesting`) so this stays a pure read of the source — no shared
// mutable-warning paths — and the nesting is keyed by the section's stableId.
// True when `page.yml::sections:` is a fully explicit array — strings and/or
// single-key nesting objects, with no `*`/`...` wildcard. In that form it is
// authoritative for BOTH order and nesting (the same contract the normal build
// honors via processExplicitSections), and section files need no numeric/`@`
// prefix. This is the form the pull projector emits, so reading it here closes
// the pull→push round trip — and aligns the producer with the build, which has
// always honored `sections:` (the producer previously ignored it, ordering by
// filename + nesting only via `nest:`). Wildcard or absent `sections:` falls
// through to the directory-order + `nest:` path below, unchanged.
function isFullyExplicitSections(sectionsConfig) {
  if (!Array.isArray(sectionsConfig) || sectionsConfig.length === 0) return false
  return sectionsConfig.every(
    (item) =>
      (typeof item === 'string' && item !== '...' && item !== '*') ||
      (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1)
  )
}

// Build the page_sections tree from an explicit `sections:` array: each item is
// a section name (string) or `{ name: [children…] }`, resolved to its file by
// name (bare / `@` / numeric-prefix tolerant) and recursed. Order and nesting
// come from the array, not the directory.
async function collectPageSectionsExplicit(pageDir, siteRoot, sectionsConfig) {
  const mdFiles = (await readdir(pageDir)).filter(isMarkdownFile).sort(compareFilenames)
  const seen = new Set()

  const buildItem = async (item) => {
    const name = typeof item === 'string' ? item : Object.keys(item)[0]
    const children = typeof item === 'string' ? null : item[name]
    const file = findSectionFileName(mdFiles, name)
    if (!file || seen.has(file)) return null // missing / already used → skip
    seen.add(file)
    const { section } = await processMarkdownFile(join(pageDir, file), String(seen.size), siteRoot, name)
    section.subsections = []
    if (Array.isArray(children)) {
      for (const child of children) {
        const sub = await buildItem(child)
        if (sub) section.subsections.push(sub)
      }
    }
    return section
  }

  const sections = []
  for (const item of sectionsConfig) {
    const s = await buildItem(item)
    if (s) sections.push(s)
  }
  return sections.map((s, i) => sectionToRecord(s, i))
}

async function collectPageSectionsNested(pageDir, siteRoot, pageConfig) {
  if (isFullyExplicitSections(pageConfig?.sections)) {
    return collectPageSectionsExplicit(pageDir, siteRoot, pageConfig.sections)
  }
  const mdFiles = (await readdir(pageDir)).filter(isMarkdownFile).sort(compareFilenames)
  const nest = pageConfig?.nest && typeof pageConfig.nest === 'object' ? pageConfig.nest : {}

  // Process one markdown file into a section object (stableId from frontmatter
  // `id:` or the filename), recursing this section's `nest:` children into
  // `.subsections`. `seen` guards against a cycle in a hand-written `nest:`.
  const buildSection = async (file, seen) => {
    const stableDefault = parseNumericPrefix(stripAtPrefix(parse(file).name)).name
    const { section } = await processMarkdownFile(
      join(pageDir, file),
      String(seen.size),
      siteRoot,
      stableDefault
    )
    const childNames = Array.isArray(nest[section.stableId]) ? nest[section.stableId] : []
    section.subsections = []
    for (const childName of childNames) {
      const childFile = findSectionFileName(mdFiles, childName)
      if (!childFile || seen.has(childFile)) continue // missing / cycle → skip
      seen.add(childFile)
      section.subsections.push(await buildSection(childFile, seen))
    }
    return section
  }

  // Top-level sections: every NON-`@` markdown file, in order. `@`-prefixed files
  // are children, pulled in via their parent's `nest:` above (an orphaned `@`
  // file with no parent is simply omitted — it stays out of the document).
  const seen = new Set()
  const sections = []
  for (const file of mdFiles) {
    if (isChildSection(file) || seen.has(file)) continue
    seen.add(file)
    sections.push(await buildSection(file, seen))
  }

  return sections.map((s, i) => sectionToRecord(s, i))
}

// Recursively build the `pages` tree: each record carries its fields, its inline
// `page_sections` (page mode only), and its child pages under `$children`.
async function walkPagesNested(ctx, dirPath, parentSlugPath, inheritedMode, parentConfig, isRoot) {
  const { siteRoot, siteIndex, sourceLocale, translations } = ctx
  const folders = await orderedSubfolders(dirPath, inheritedMode, parentConfig)
  const out = []
  for (let i = 0; i < folders.length; i++) {
    const f = folders[i]
    const dyn = f.dirName.match(DYNAMIC_RE)
    const slug = dyn ? dyn[1] : f.name
    const mode = f.source === 'folder.yml' ? 'folder' : 'page'
    const slugPath = parentSlugPath ? `${parentSlugPath}/${slug}` : slug

    const data = buildPageData(f.config, {
      slug,
      mode,
      isDynamic: !!dyn,
      paramName: dyn ? dyn[1] : undefined,
      isRoot,
      siteIndex,
      sourceLocale,
      translations,
    })
    // `$id` is the stableId when authored (rename-stable), else the slug (the
    // natural handle — spec default). The path is NEVER the identity.
    const id = data.stable_id || slug
    const record = withIdentity(id, data)

    if (mode === 'page') {
      const sections = await collectPageSectionsNested(f.path, siteRoot, f.config)
      if (sections.length > 0) record.page_sections = sections
    }

    const children = await walkPagesNested(ctx, f.path, slugPath, f.internalMode, f.config, false)
    if (children.length > 0) record.$children = children

    out.push(record)
  }
  return out
}

// layout_sections: top-level self-nesting, keyed by (layout_name, area) in data.
// Same per-area walk as collectLayoutSections, emitted as `$`-records.
async function collectLayoutNested(layoutDir, siteRoot) {
  if (!existsSync(layoutDir)) return []
  const items = []
  let order = 0
  async function addArea(filePath, layoutName, area) {
    const { section } = await processMarkdownFile(filePath, String(order + 1), siteRoot, area)
    const stable = section.stableId || String(order)
    items.push(
      withIdentity(stable, { layout_name: layoutName, area, ...mapSectionData(section) })
    )
    order++
  }
  const entries = await readdir(layoutDir, { withFileTypes: true })
  const rootMd = entries
    .filter((e) => e.isFile() && isMarkdownFile(e.name))
    .map((e) => e.name)
    .sort(compareFilenames)
  for (const file of rootMd) {
    await addArea(join(layoutDir, file), 'default', parseNumericPrefix(parse(file).name).name)
  }
  for (const e of entries) {
    if (!e.isDirectory() || isIgnoredFolder(e.name)) continue
    const sub = join(layoutDir, e.name)
    const md = (await readdir(sub)).filter(isMarkdownFile).sort(compareFilenames)
    for (const file of md) {
      await addArea(join(sub, file), e.name, parseNumericPrefix(parse(file).name).name)
    }
  }
  return items
}

function extensionsNested(siteYml) {
  const ext = siteYml.extensions
  if (!Array.isArray(ext)) return []
  const out = []
  for (const url of ext) {
    if (typeof url !== 'string') continue // object form deferred (v0)
    out.push(withIdentity(url, { url }))
  }
  return out
}

// The collection DECLARATIONS carried inside site-content `info`-adjacent metadata.
// Merges the co-located `collections.yml` (the home for file-based decls) over the
// legacy `site.yml::collections` (kept for remote `url:` sources + back-compat).
function collectionsNested(declarations) {
  const out = []
  for (const [name, d] of Object.entries(declarations)) {
    const data = {}
    const source = d.path ? { path: d.path } : d.url ? { url: d.url } : d.source
    setIf(data, 'source', source)
    setIf(data, 'schema', d.schema)
    setIf(data, 'sort', d.sort)
    // Legacy `filter:` is not synced — it is translated to `where` upstream
    // (the canonical predicate). No legacy fields on the wire.
    setIf(data, 'where', d.where)
    setIf(data, 'limit', d.limit)
    setIf(data, 'excerpt', d.excerpt)
    setIf(data, 'deferred', d.deferred)
    setIf(data, 'detail_url', d.detailUrl)
    setIf(data, 'queryable', d.queryable)
    out.push(withIdentity(name, { name, ...data }))
  }
  return out
}

/**
 * Map a file site project to the nested `@uniweb/site-content` `$`-document
 * (see the lane header above). PURE — reads the project, never mints, never writes.
 * The entity `$uuid` comes from `site.yml::$uuid` (back-filled after first sync);
 * nested items carry `$id` only.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {string} [opts.entityUuid] - override the entity `$uuid` (tests); default
 *        is `site.yml::$uuid` (absent on first sync — `$id`-only document).
 * @param {string} [opts.sourceLocale] - localized-field wrap locale (default "en").
 * @returns {Promise<object>} the section-keyed `$`-document:
 *        `{ $uuid?, $id, $model, info, pages, layout_sections, extensions, collections }`
 */
export async function siteProjectToDocument(siteRoot, opts = {}) {
  const sourceLocale =
    opts.sourceLocale || LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale

  const siteYml = await readYamlFile(join(siteRoot, 'site.yml'))
  if (!siteYml.name) {
    throw new Error('uwx/site: site.yml::name is required')
  }
  if (!siteYml.foundation || typeof siteYml.foundation !== 'string') {
    throw new Error(
      'uwx/site: site.yml::foundation (a reference string) is required — ' +
        'it maps to the required @uniweb/site-content info.foundation'
    )
  }

  const themeYml = await readYamlFile(join(siteRoot, 'theme.yml'))
  let headHtml
  try {
    headHtml = await readFile(join(siteRoot, 'head.html'), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  // Target-locale translations (locales/{locale}.json) for wrapping localized
  // scalars back into per-locale form. Source-locale-only when no target locales /
  // no locale files exist (single-locale sites are unaffected).
  const targetLocales = (Array.isArray(siteYml.languages) ? siteYml.languages : []).filter(
    (l) => l !== sourceLocale
  )
  const translations = targetLocales.length > 0 ? loadLocaleTranslations(siteRoot, targetLocales) : null

  const info = {}
  info.name = localizeScalar(siteYml.name, sourceLocale, translations)
  setIf(info, 'description', localizeScalar(siteYml.description, sourceLocale, translations))
  if (themeYml && Object.keys(themeYml).length > 0) info.theme = themeYml
  setIf(info, 'languages', siteYml.languages)
  setIf(info, 'default_language', siteYml.defaultLanguage)
  // `foundation` (required) — the verbatim `site.yml::foundation` string
  // (registry ref / URL / local path), the round-trip source of truth.
  info.foundation = siteYml.foundation
  setIf(info, 'base', siteYml.base)
  // favicon — a verbatim URL/path string (the kit resolves it, like other media
  // refs). `assets` is a build-DERIVED upload manifest, not authored config, so it
  // is never produced from / projected to the site files.
  setIf(info, 'favicon', siteYml.favicon)
  setIf(info, 'head_html', headHtml)
  setIf(info, 'fetcher', siteYml.fetcher)
  setIf(info, 'build', siteYml.build)
  setIf(info, 'search', siteYml.search)
  setIf(info, 'paths', siteYml.paths)
  setIf(info, 'data', siteYml.data ?? siteYml.fetch)

  const ctx = { siteRoot, siteIndex: siteYml.index, sourceLocale, translations }
  const pagesPath = siteYml.paths?.pages
    ? join(siteRoot, siteYml.paths.pages)
    : join(siteRoot, 'pages')
  const pages = existsSync(pagesPath)
    ? await walkPagesNested(ctx, pagesPath, '', 'sections', siteYml, true)
    : []

  const layoutDir = siteYml.paths?.layout
    ? join(siteRoot, siteYml.paths.layout)
    : join(siteRoot, 'layout')
  const layoutSections = await collectLayoutNested(layoutDir, siteRoot)

  // Wrap each section's content into its per-locale form (source doc + target
  // structural maps from locales/{locale}.json, or a free-form body override from
  // locales/freeform/**) when the site is multi-locale. A non-invasive post-pass
  // over the built tree — single-locale sites are untouched.
  if (targetLocales.length > 0) {
    await localizeContentTree(pages, layoutSections, sourceLocale, targetLocales, translations, siteRoot)
  }

  // Collection DECLARATIONS — the merged collections.yml + site.yml::collections
  // config (the records themselves are separate entities; this is just the config).
  const colConfig = await resolveCollectionsConfig(siteRoot, { siteYml })

  // `$uuid?` then `$id` `$model`, then sections in Model-declared order. The entity
  // `$uuid` lives in site.yml (back-filled after first sync); absent on first sync.
  const doc = {}
  const entityUuid =
    opts.entityUuid || (typeof siteYml.$uuid === 'string' ? siteYml.$uuid : undefined)
  if (entityUuid) doc.$uuid = entityUuid
  doc.$id = SITE_ENTITY_KEY // one site-content entity per project (stable handle)
  doc.$model = SITE_MODEL_NAME
  doc.info = info
  doc.pages = pages
  doc.layout_sections = layoutSections
  doc.extensions = extensionsNested(siteYml)
  doc.collections = collectionsNested(colConfig.declarations)
  return doc
}

/**
 * Site project -> a one-entity `@uniweb/site-content` `.uwx` Buffer on the SYNC
 * lane (the nested `$`-document; Model resolved BY NAME). Parallel to
 * `emitSitePackage` (the flat register lane) — both remain until the backend
 * confirms which lane site-content sync ingests (bidirectional-sync §8/§9).
 *
 * @param {string} siteRoot
 * @param {object} [opts] - same as siteProjectToDocument, plus `exporter`,
 *        `exportedAt`.
 * @returns {Promise<Buffer>}
 */
export async function emitSiteSyncPackage(siteRoot, opts = {}) {
  const document = await siteProjectToDocument(siteRoot, opts)
  return emitEntitySyncPackage({
    entities: [
      {
        id: document.$id,
        model: document.$model,
        file: 'entities/site-content.json',
        document,
      },
    ],
    modelsRequired: [{ name_at_export: SITE_MODEL_NAME }],
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })
}

// ===========================================================================
// Identity back-fill.
//
// The ENTITY `$uuid` (the backend's identity for the whole site-content entity) is
// back-filled into `site.yml::$uuid` after the first sync. That is the ONLY backend
// uuid for site-content — its nested pages/sections sync wholesale (collision=force),
// so there is no per-item uuid round-trip. Per-item identity for the eventual PULL is
// recovered by in-file `stableId` + content-match (Plan D), not a local id store.
// ===========================================================================

/**
 * Back-fill the minted site-content entity `$uuid` into `site.yml` (top-level
 * `$uuid`), preserving the file's comments and key order.
 * @param {string} siteRoot
 * @param {string} uuid - the entity uuid the backend minted/echoed
 * @returns {boolean} true if site.yml changed
 */
export function writeSiteEntityUuid(siteRoot, uuid) {
  return upsertYamlScalar(join(siteRoot, 'site.yml'), '$uuid', uuid)
}
