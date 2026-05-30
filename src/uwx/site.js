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
// `layout_sections` · `extensions` · `collections`. `info.foundation_ref`
// carries the verbatim `site.yml::foundation` string (the round-trip source of
// truth). Identity is `$id` (the stableId); `$uuid` is injected read-only from
// the committed id sidecar — the backend mints it, never this producer.
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
import { emitEntitySyncPackage } from './entity-document.js'
import { localize, LOCALIZED_FIELD_ASSUMPTION } from './localize.js'
import { sidecarLookup, SIDECAR_RELPATH } from './identity.js'

const SITE_ENTITY_KEY = 'site-content' // one content entity per site project

function setIf(obj, key, value) {
  if (value !== undefined) obj[key] = value
}

// page_sections and layout_sections share this content shape.
// processMarkdownFile only destructures type/component/preset/input/props/
// fetch/data/id out of frontmatter, so `background:` and `theme:` stay
// inside section.params — lift them into the entity type's dedicated fields.
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
  const { slug, mode, isDynamic, paramName, isRoot, siteIndex, sourceLocale } =
    ctx
  const data = { slug, mode } // both required by the entity type
  setIf(data, 'stable_id', config.id)
  setIf(data, 'title', localize(config.title, sourceLocale))
  setIf(data, 'description', localize(config.description, sourceLocale))
  setIf(data, 'label', localize(config.label, sourceLocale))
  setIf(data, 'keywords', config.keywords)
  const indexed =
    config.index === true || (isRoot && siteIndex && siteIndex === slug)
  if (indexed) data.is_index = true
  setIf(data, 'hidden', config.hidden)
  setIf(data, 'hide_in_header', config.hideInHeader)
  setIf(data, 'hide_in_footer', config.hideInFooter)
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
//   - identity is `$id` (the stableId — the in-file handle), with `$uuid` injected
//     ONLY from the committed sidecar when known (read-only lookup; the backend
//     mints, the verb records — uuids never touch authored files). §4 of the plan.
//
// v0 deferrals: folder-mode `.md`-as-pages, `paths:` mounts, versioned scopes, and
// media/asset bytes (favicon/assets, carried out of band). `@`-prefix `nest:`
// hierarchy is NOT deferred — it is reconstructed here, same as a normal build.
// ===========================================================================

const SITE_MODEL_NAME = '@uniweb/site-content'

// ---------------------------------------------------------------------------
// Sidecar keys — the SINGLE source of truth for how a record maps to its
// `.uniweb/uwx-ids.json` slot. Used on BOTH sides of the round trip: the
// producer (`siteProjectToDocument`) reads a uuid by key; the back-fill
// (`siteSidecarEntries`) writes the minted uuid back under the SAME key. They
// must never diverge, so they call these — not inline template strings.
//
//   - page    : `page:id:<stableId>`  when authored; else `page:path:<slugPath>`
//               (path is a fallback only — a rename breaks it; §4)
//   - section : `<parentKey>::sec:<secId>`  (chains for self-nested @-children)
//   - layout  : `layout:<layoutName>/<area>:<stable>`
//   - ext     : `ext:<url>`            - col: `col:<name>`
// ---------------------------------------------------------------------------
const pageKeyFor = (stableId, slugPath) =>
  stableId ? `page:id:${stableId}` : `page:path:${slugPath}`
const sectionKeyFor = (parentKey, secId) => `${parentKey}::sec:${secId}`
const layoutKeyFor = (layoutName, area, stable) => `layout:${layoutName}/${area}:${stable}`
const extKeyFor = (url) => `ext:${url}`
const colKeyFor = (name) => `col:${name}`

// `$uuid?` then `$id`, then the record's fields — the wire's canonical key order
// (mirrors collections.js). `fields` already carries `stable_id` (the Model field);
// `$id` is the same value as the identity sigil. Both are kept: `$id` is the sync
// handle, `stable_id` is the declared content field the editor/render reads.
function withIdentity(id, uuid, fields) {
  const rec = {}
  if (uuid) rec.$uuid = uuid
  rec.$id = id
  return Object.assign(rec, fields)
}

// One collected section → its `$`-record, recursing `subsections` into `$children`
// (page_sections is self_nesting). The sidecar key chains by stableId at every
// depth, so a uuid stays bound to a section through a rename or a re-order.
function sectionToRecord(section, parentKey, lookup, index) {
  const secId = section.stableId || `s${index}`
  const key = sectionKeyFor(parentKey, secId)
  const rec = withIdentity(secId, lookup.item(key), mapSectionData(section))
  if (Array.isArray(section.subsections) && section.subsections.length > 0) {
    rec.$children = section.subsections.map((c, j) =>
      sectionToRecord(c, key, lookup, j)
    )
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
async function collectPageSectionsNested(pageDir, siteRoot, pageKey, lookup, pageConfig) {
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

  return sections.map((s, i) => sectionToRecord(s, pageKey, lookup, i))
}

// Recursively build the `pages` tree: each record carries its fields, its inline
// `page_sections` (page mode only), and its child pages under `$children`.
async function walkPagesNested(ctx, dirPath, parentSlugPath, inheritedMode, parentConfig, isRoot) {
  const { siteRoot, lookup, siteIndex, sourceLocale } = ctx
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
    })
    // `$id` is the stableId when authored (rename-stable), else the slug (the
    // natural handle — spec default). The path is NEVER the identity; the sidecar
    // key falls back to slugPath only to locate a prior uuid for a still-id-less
    // page, which "make stableId authoritative" (§4) removes by minting an id.
    const id = data.stable_id || slug
    const pageKey = pageKeyFor(data.stable_id, slugPath)
    const record = withIdentity(id, lookup.item(pageKey), data)

    if (mode === 'page') {
      const sections = await collectPageSectionsNested(f.path, siteRoot, pageKey, lookup, f.config)
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
async function collectLayoutNested(layoutDir, siteRoot, lookup) {
  if (!existsSync(layoutDir)) return []
  const items = []
  let order = 0
  async function addArea(filePath, layoutName, area) {
    const { section } = await processMarkdownFile(filePath, String(order + 1), siteRoot, area)
    const stable = section.stableId || String(order)
    const uuid = lookup.item(layoutKeyFor(layoutName, area, stable))
    items.push(
      withIdentity(stable, uuid, { layout_name: layoutName, area, ...mapSectionData(section) })
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

function extensionsNested(siteYml, lookup) {
  const ext = siteYml.extensions
  if (!Array.isArray(ext)) return []
  const out = []
  for (const url of ext) {
    if (typeof url !== 'string') continue // object form deferred (v0)
    out.push(withIdentity(url, lookup.item(extKeyFor(url)), { url }))
  }
  return out
}

function collectionsNested(siteYml, lookup) {
  const col = siteYml.collections
  if (!col || typeof col !== 'object' || Array.isArray(col)) return []
  const out = []
  for (const [name, decl] of Object.entries(col)) {
    const d = decl && typeof decl === 'object' ? decl : {}
    const data = {}
    const source = d.path ? { path: d.path } : d.url ? { url: d.url } : d.source
    setIf(data, 'source', source)
    setIf(data, 'sort', d.sort)
    setIf(data, 'filter', d.filter)
    setIf(data, 'where', d.where)
    setIf(data, 'limit', d.limit)
    setIf(data, 'excerpt', d.excerpt)
    setIf(data, 'deferred', d.deferred)
    setIf(data, 'detail_url', d.detailUrl)
    setIf(data, 'queryable', d.queryable)
    out.push(withIdentity(name, lookup.item(colKeyFor(name)), { name, ...data }))
  }
  return out
}

/**
 * Map a file site project to the nested `@uniweb/site-content` `$`-document
 * (Phase 0 shape — see the lane header above). PURE except for the read-only
 * sidecar lookup; never mints, never writes.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {boolean|string} [opts.sidecar] - read uuids from this sidecar (`true` →
 *        `<siteRoot>/.uniweb/uwx-ids.json`; a string → that path). Default: none
 *        (first-sync shape — `$id` only, no `$uuid`).
 * @param {string} [opts.sourceLocale] - localized-field wrap locale (default "en").
 * @returns {Promise<object>} the section-keyed `$`-document:
 *        `{ $uuid?, $id, $model, info, pages, layout_sections, extensions, collections }`
 */
export async function siteProjectToDocument(siteRoot, opts = {}) {
  const sourceLocale =
    opts.sourceLocale || LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale
  const lookup = opts.sidecar
    ? sidecarLookup(
        typeof opts.sidecar === 'string' ? opts.sidecar : join(siteRoot, SIDECAR_RELPATH)
      )
    : { entity: () => undefined, item: () => undefined }

  const siteYml = await readYamlFile(join(siteRoot, 'site.yml'))
  if (!siteYml.name) {
    throw new Error('uwx/site: site.yml::name is required')
  }
  if (!siteYml.foundation || typeof siteYml.foundation !== 'string') {
    throw new Error(
      'uwx/site: site.yml::foundation (a reference string) is required — ' +
        'it maps to the required @uniweb/site-content info.foundation_ref'
    )
  }

  const themeYml = await readYamlFile(join(siteRoot, 'theme.yml'))
  let headHtml
  try {
    headHtml = await readFile(join(siteRoot, 'head.html'), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const info = {}
  info.name = localize(siteYml.name, sourceLocale)
  setIf(info, 'description', localize(siteYml.description, sourceLocale))
  if (themeYml && Object.keys(themeYml).length > 0) info.theme = themeYml
  setIf(info, 'locales', siteYml.languages)
  setIf(info, 'default_locale', siteYml.defaultLanguage)
  info.foundation_ref = siteYml.foundation // the round-trip source of truth
  setIf(info, 'base_path', siteYml.base)
  setIf(info, 'head_html', headHtml)
  setIf(info, 'fetcher_config', siteYml.fetcher)
  setIf(info, 'build_options', siteYml.build)
  setIf(info, 'search_config', siteYml.search)
  setIf(info, 'paths_config', siteYml.paths)
  setIf(info, 'data_config', siteYml.data ?? siteYml.fetch)

  const ctx = { siteRoot, lookup, siteIndex: siteYml.index, sourceLocale }
  const pagesPath = siteYml.paths?.pages
    ? join(siteRoot, siteYml.paths.pages)
    : join(siteRoot, 'pages')
  const pages = existsSync(pagesPath)
    ? await walkPagesNested(ctx, pagesPath, '', 'sections', siteYml, true)
    : []

  const layoutDir = siteYml.paths?.layout
    ? join(siteRoot, siteYml.paths.layout)
    : join(siteRoot, 'layout')
  const layoutSections = await collectLayoutNested(layoutDir, siteRoot, lookup)

  // `$uuid?` then `$id` `$model`, then sections in Model-declared order.
  const doc = {}
  const entityUuid = opts.entityUuid || lookup.entity(SITE_ENTITY_KEY)
  if (entityUuid) doc.$uuid = entityUuid
  doc.$id = SITE_ENTITY_KEY // one site-content entity per project (stable handle)
  doc.$model = SITE_MODEL_NAME
  doc.info = info
  doc.pages = pages
  doc.layout_sections = layoutSections
  doc.extensions = extensionsNested(siteYml, lookup)
  doc.collections = collectionsNested(siteYml, lookup)
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
// Sidecar back-fill — record the minted `$uuid`s from a sync response.
//
// The backend mints a `$uuid` for the entity and every nested record, and echoes
// the full document back with those uuids injected at every level (the sync
// lane's `finalized[].document`; see entity-content.md and the backend's
// `content::build`). We derive each record's sidecar KEY from the PRODUCER
// document (it has the complete structure + the `$id`/field data the keys need —
// including the positional `s<n>` fallback), and read the matching `$uuid` from
// the FINALIZED document by a lockstep structural walk. Keys come from the side
// we fully control; uuids from the side the backend filled in. Same structure on
// both (the backend echoes what it stored), so the walk aligns; a shape mismatch
// is skipped, never mis-bound.
// ===========================================================================

// Build { entities, items } sidecar additions from a producer↔finalized doc pair.
export function siteSidecarEntries(producerDoc, finalizedDoc) {
  const entities = {}
  const items = {}
  if (finalizedDoc?.$uuid) entities[SITE_ENTITY_KEY] = finalizedDoc.$uuid

  const visitSections = (prod, fin, parentKey) => {
    for (let i = 0; i < (prod?.length || 0); i++) {
      const p = prod[i]
      const f = fin?.[i]
      const key = sectionKeyFor(parentKey, p.$id)
      if (f?.$uuid) items[key] = f.$uuid
      if (Array.isArray(p.$children)) visitSections(p.$children, f?.$children, key)
    }
  }
  const visitPages = (prod, fin, parentSlugPath) => {
    for (let i = 0; i < (prod?.length || 0); i++) {
      const p = prod[i]
      const f = fin?.[i]
      const slugPath = parentSlugPath ? `${parentSlugPath}/${p.slug}` : p.slug
      const key = pageKeyFor(p.stable_id, slugPath)
      if (f?.$uuid) items[key] = f.$uuid
      if (Array.isArray(p.page_sections)) visitSections(p.page_sections, f?.page_sections, key)
      if (Array.isArray(p.$children)) visitPages(p.$children, f?.$children, slugPath)
    }
  }

  visitPages(producerDoc?.pages, finalizedDoc?.pages, '')

  const prodLayout = producerDoc?.layout_sections || []
  const finLayout = finalizedDoc?.layout_sections || []
  for (let i = 0; i < prodLayout.length; i++) {
    const p = prodLayout[i]
    const f = finLayout[i]
    if (f?.$uuid) items[layoutKeyFor(p.layout_name, p.area, p.$id)] = f.$uuid
  }
  const prodExt = producerDoc?.extensions || []
  const finExt = finalizedDoc?.extensions || []
  for (let i = 0; i < prodExt.length; i++) {
    if (finExt[i]?.$uuid) items[extKeyFor(prodExt[i].url)] = finExt[i].$uuid
  }
  const prodCol = producerDoc?.collections || []
  const finCol = finalizedDoc?.collections || []
  for (let i = 0; i < prodCol.length; i++) {
    if (finCol[i]?.$uuid) items[colKeyFor(prodCol[i].name)] = finCol[i].$uuid
  }
  return { entities, items }
}

/**
 * Merge the minted site-content `$uuid`s into the committed sidecar.
 * @param {string} sidecarPath   - `.uniweb/uwx-ids.json`
 * @param {object} producerDoc   - the document we submitted (key source)
 * @param {object} finalizedDoc  - the backend's echoed document (uuid source)
 * @returns {{ entities: object, items: object }} the additions written
 */
export function writeSiteSidecar(sidecarPath, producerDoc, finalizedDoc) {
  const additions = siteSidecarEntries(producerDoc, finalizedDoc)
  writeSidecarStore(sidecarPath, additions)
  return additions
}
