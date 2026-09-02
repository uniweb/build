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
// `layout_sections` · `extensions` · `queries`. `info.foundation`
// carries the verbatim `site.yml::foundation` string (the round-trip source of
// truth).
//
// IDENTITY. The ENTITY `$uuid` lives in `site.yml` (top-level `$uuid`); we read it,
// send it, and back-fill the minted value there. Nested pages/sections carry a `$id`
// handle AND a per-item `$uuid`.
//
// The per-item uuid is NOT authored — author files never carry sync uuids. It is
// stamped at emit (`stampUnitUuids`) from an out-of-band cache populated by whatever
// the backend last reported: a pull, or a push response's `finalized[].document`.
// This is load-bearing, not bookkeeping: the backend matches records by uuid, and
// `pages` / `page_sections` / `layout_sections` are all `multi` sections, where a
// uuid-less record is read as NEW — inserted, with its stored counterpart deleted as
// host-only. Sending without it replaced every page and section row on every push,
// which silently invalidated the per-item handles the app holds for its own
// concurrency. (This note previously said the opposite and described the wholesale
// treatment as intended; it was neither intended nor harmless.)
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
import { resolveDefaultLocale, validateLanguageConfig, queryDataUrl } from '@uniweb/core'
import { emitEntitySyncPackage } from './entity-document.js'
import { loadLocaleTranslations, localizeScalar, localizeScalarList, localizeContentDoc, localesDir, isLocalizedContent } from './locale-sync.js'
import { unwrapLocalized } from './backfill.js'
import { loadFreeformTranslation } from '../i18n/freeform.js'
import { upsertYamlScalar } from './yaml-upsert.js'
import { resolveQueriesConfig } from './queries-config.js'

const SITE_ENTITY_KEY = 'site-content' // one content entity per site project

function setIf(obj, key, value) {
  if (value !== undefined) obj[key] = value
}

// Credential-shaped keys, mirroring the set the delivery edge strips on the
// reading side. Deliberately the SAME list rather than a stricter one, so the
// two guards are visibly twins and a key added to one is obviously owed to the
// other.
const CREDENTIAL_KEYS = ['apiKey', 'api_key', 'key', 'token', 'secret']

/**
 * Drop credential-shaped keys out of an authored service block.
 *
 * An authored block crosses into backend storage here and is served from there
 * in a published payload — which is world-readable. So a credential in
 * `site.yml` is not merely untidy, it is disclosed. The host's secret store is
 * the only right home, resolved at request time.
 *
 * Warns rather than throwing: the fix belongs to the author, a failed push
 * helps nobody, and the block is still useful without the key. Returns the
 * value untouched when there is nothing to strip, so `setIf`'s absent-vs-empty
 * behaviour is unchanged — a block that carried ONLY a credential arrives as
 * `{}` rather than vanishing, keeping the mistake visible where the author
 * looks for it.
 *
 * @param {*} block - the authored value, any shape
 * @param {string} label - the site.yml key, for the warning
 * @returns {*} the block, minus anything credential-shaped
 */
function stripCredentials(block, label) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block
  const found = CREDENTIAL_KEYS.filter(key => key in block)
  if (found.length === 0) return block

  console.warn(
    `uwx/site: dropped ${found.join(', ')} from \`${label}:\` — authored config is published ` +
      'world-readable, so a credential belongs in the host secret store, never in site.yml.'
  )

  const cleaned = { ...block }
  for (const key of found) delete cleaned[key]
  return cleaned
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
      // `slug` is a localized `{lang:value}` map; the free-form route is the
      // canonical (source-locale) path, so unwrap before building it.
      const slug = unwrapLocalized(p.slug, sourceLocale)
      const route = routePrefix ? `${routePrefix}/${slug}` : slug
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
  // The page `slug` is the localized route source — a `{lang: slug}` map (the
  // site-content Model declares it localized; greenlit 2026-06-13). A single-locale
  // site emits one entry (`{ en: "home" }`); per-locale slug overrides for
  // multi-locale localized routes (from i18n.routeTranslations) are follow-on
  // producer work. `mode` is the plain delivery mode.
  const data = { slug: { [sourceLocale]: slug }, mode } // both required by the entity type
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
  // Agent-only content. Sent as authored — only the marked page carries it, and
  // the cascade to descendants is the CONSUMER's to compute (by route prefix, or
  // equivalently by walking the page tree). A reader that tests this field alone
  // honours the branch root and silently misses every child.
  setIf(data, 'knowledge', config.knowledge)
  // Per-page section instrumentation opt-in. ⭐ Authored camelCase → wire
  // snake_case, the same crossing `hideIn` → `hide_in` already makes; the
  // backend's field list is entirely snake_case and stays that way.
  // ⛔ It MUST cross: without this line the flag works on `--bundle`/`--link`
  // and is silently ignored on a backend-hosted site, where page config comes
  // from the backend's projection — i.e. it would fail on the one lane the
  // feature is sold on, with no instrument able to say why.
  // ⚠️ Declared backend-side FIRST (`track_sections`, generation 7) — an
  // undeclared field refuses the whole push, not the field.
  setIf(data, 'track_sections', config.trackSections)
  setIf(data, 'redirect', config.redirect)
  setIf(data, 'rewrite', config.rewrite)
  setIf(data, 'layout', config.layout)
  setIf(data, 'seo', config.seo)
  // ⭐ A `data:` LIST means "fetch each" — one declaration per entry. Before
  // 2026-09-02 this kept `[0]` and dropped the rest silently, so the wire
  // carried one dataset for a page that asked for several.
  let fetch =
    config.fetch ??
    (config.data
      ? (Array.isArray(config.data) ? config.data.map((query) => ({ query })) : { query: config.data })
      : undefined)
  // Resolve the authored `query:` shorthand to the runtime-fetchable
  // `path: /data/<name>.json` (the static convention the default-fetcher uses).
  // A shell/backend-hosted site renders client-side with NO prerender, so the
  // runtime fetches this decl directly — and `query:` is build-time-only, so
  // it would never resolve at render (the static build resolves it the same way
  // in site/data-fetcher.js parseFetchConfig). The gateway serves the collection
  // at `<base>/data/<name>.json`.
  // ⛔ **Mapped, not read.** A `data:`/`fetch:` LIST reaches here as an array, and
  // `fetch.query` on one is `undefined` — so a property test would skip the
  // resolution below and put bare `{ query }` entries on the wire with no
  // `path`, no `as` and no `schema`. That is the silent-empty class: a payload
  // that arrives, parses, and resolves to nothing.
  const resolveWireFetch = (one) => {
    if (!one || typeof one.query !== 'string') return one
    const { query, ...rest } = one
    // ⭐ BOTH, deliberately, and they are not redundant.
    //
    //   `query` — the author's named query, unresolved. A consumer that can ask
    //     a host where records live (`config.records`) resolves it there, which
    //     is the only way a live lane is reachable at all: a resolved path names
    //     one place and closes the question.
    //
    //   `path` — the compiled artifact, the answer when nobody declares a lane.
    //     Also what a consumer still reading `fetch.path` gets, so teaching the
    //     wire a new field does not break one that has not learned it.
    //
    // `@uniweb/core`'s resolveFetchConfigs gives the query precedence and drops
    // `path` once it has resolved an address — matching parseFetchConfig, which
    // has always returned early on the shorthand.
    //
    // `schema` (the query name) is BOTH the content.data key and part of the
    // dataStore cache key (deriveCacheKey hashes {path,url,endpoint,schema,…};
    // the shorthand is ignored). Mirrors the static build's parseFetchConfig —
    // ⚠️ which it did NOT until 2026-09-02. This line emitted `query` and that
    // one did not, for the same declaration, so `resolveQuerySource` fired on a
    // published site and never on a `--link`-deployed one: same site, two verbs,
    // two data sources. The claim was here the whole time; the mirroring was not.
    // ⭐ `query`, END TO END — no crossing. An earlier version emitted `collection`
    // here on the belief that this field was the backend's to name. MEASURED
    // otherwise: framework already ships `transform`, `detailPage`, `merge` and
    // `prerender` inside this same `fetch` object, which no backend could be
    // validating — so `fetch` is a blob they carry and framework owns its
    // vocabulary. ⇒ There was nothing to coordinate, and inventing a coordination
    // is how a name stays wrong.
    // ⛔ `as`, the BINDING KEY — not to be confused with `schema` at
    // DECL_EMITTED_ABOVE / `setIf(data,'schema',d.schema)` below, which is a
    // queries decl's MODEL REF and keeps its name. One word meant both until
    // 2026-09-02; this is the half that moved.
    // Both spellings, deliberately — an `as`-only payload is skipped entirely by
    // any runtime older than `bindingKey` (`if (!cfg?.schema) continue`), with no
    // data and no error. Drop `schema` when every serving runtime carries it.
    return { query, path: queryDataUrl(query), as: query, schema: query, ...rest }
  }
  fetch = Array.isArray(fetch) ? fetch.map(resolveWireFetch) : resolveWireFetch(fetch)
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
// declares (the backend's site-content system-model fixture) and that
// docs/reference/entity-content.md specifies:
//
//   - `page_sections` is a CHILD section of `pages` → it rides as an INLINE FIELD
//     on each page record (the spec's cross-section rule: "a subsection is an
//     inline field"), NOT a top-level array with a back-reference.
//   - genuine self-nesting uses `$children`: a folder's child pages (within
//     `pages`), and `@`-prefix child sections declared in `nest:` (within
//     `page_sections`). Cross-section parentage is pure structure, never `$parent`.
//   - `$id` (the stableId — the in-file handle) rides at every item level as the
//     wire-only closure handle. Per-item `$uuid` is NOT authored here: it is
//     stamped on by `stampUnitUuids` at emit, from the out-of-band identity cache,
//     because the backend matches records by uuid and a uuid-less record in a
//     `multi` section is read as new (inserted, stored counterpart deleted). See
//     the IDENTITY note in the file header and `site-diff.js`.
//
// v0 deferrals: folder-mode `.md`-as-pages, `paths:` mounts, versioned scopes, and
// media/asset bytes (favicon/assets, carried out of band). `@`-prefix `nest:`
// hierarchy is NOT deferred — it is reconstructed here, same as a normal build.
// ===========================================================================

const SITE_MODEL_NAME = '@uniweb/site-content'

// `$id` (the handle), then the record's fields — the wire's canonical key order.
// `fields` already carries `stable_id` (the Model field); `$id` is the same value.
// Both are kept: `$id` is the sync handle, `stable_id` is the declared content field
// the editor/render reads. Per-item `$uuid` is added later by `stampUnitUuids` (it
// comes from the identity cache, not from the authored files) — see the IDENTITY
// note in the file header.
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

// The same list plus a `...` rest marker: the named entries still give order and
// nesting, and anything undiscovered is appended. `uniweb pull` writes exactly this
// shape, because a bare list would make the page STRICT and silently exclude every
// section added after the pull.
function isExplicitWithRest(sectionsConfig) {
  if (!Array.isArray(sectionsConfig) || sectionsConfig.length === 0) return false
  if (!sectionsConfig.includes('...')) return false
  return isFullyExplicitSections(sectionsConfig.filter((i) => i !== '...'))
}

// Build the page_sections tree from an explicit `sections:` array: each item is
// a section name (string) or `{ name: [children…] }`, resolved to its file by
// name (bare / `@` / numeric-prefix tolerant) and recursed. Order and nesting
// come from the array, not the directory.
async function collectPageSectionsExplicit(pageDir, siteRoot, sectionsConfig, { appendRest = false } = {}) {
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
    if (item === '...') continue // the rest marker itself names no section
    const s = await buildItem(item)
    if (s) sections.push(s)
  }

  // `...` — append any top-level file the list didn't claim, in filename order, so
  // a section added after a pull appears instead of being silently dropped.
  // `seen` already holds every file the list used, children included, so a nested
  // child is never also promoted to a sibling of its own parent.
  if (appendRest) {
    for (const file of mdFiles) {
      if (isChildSection(file) || seen.has(file)) continue
      seen.add(file)
      const stableDefault = parseNumericPrefix(stripAtPrefix(parse(file).name)).name
      const { section } = await processMarkdownFile(join(pageDir, file), String(seen.size), siteRoot, stableDefault)
      section.subsections = []
      sections.push(section)
    }
  }
  return sections.map((s, i) => sectionToRecord(s, i))
}

async function collectPageSectionsNested(pageDir, siteRoot, pageConfig) {
  if (isFullyExplicitSections(pageConfig?.sections)) {
    return collectPageSectionsExplicit(pageDir, siteRoot, pageConfig.sections)
  }
  if (isExplicitWithRest(pageConfig?.sections)) {
    return collectPageSectionsExplicit(pageDir, siteRoot, pageConfig.sections, { appendRest: true })
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

// An extension IS a foundation (same build, same output — it just contributes no
// Layout or theme vars), so it is DECLARED the same way the primary is: a catalog
// ref, a URL, or a local name the producer resolves. Ruling, 2026-08-04: "extensions
// should be delivered like any other foundation."
//
// The wire therefore carries whichever the author wrote, never a resolution:
//   `@org/name@1.2.3`  → { ref }   the host resolves it, exactly as for the primary
//   `https://…`        → { url }   an explicit URL, any origin
//   anything else      → { ref }   a local name; `publish` releases it and stamps
//                                  the pinned `@scope/name@version` over this entry
//                                  (see injectExtensions in sync-package.js)
//
// `$id` is the authored declaration, so an entry keeps its identity across a
// re-publish even when the ref it resolves to moves.
//
// ⚠️ A SITE-RELATIVE url (`/effects/entry.js`) is the self-hosted shape and does not
// work on a backend-hosted site: the site ships no JS, so nothing serves that path
// and the request falls through to the SPA shell — 200 with `text/html`, which
// `import()` then fails to parse. `publish` rejects it with a pointer to the ref
// form; `export` / `deploy --host` keep working, since there the site does serve
// its own files.
function extensionsNested(siteYml) {
  const ext = siteYml.extensions
  if (!Array.isArray(ext)) return []
  const out = []
  for (const entry of ext) {
    const decl = extensionDeclaration(entry)
    if (decl) out.push(withIdentity(decl.$id, decl.fields))
  }
  return out
}

/**
 * One authored `extensions:` entry → its wire fields, or null when unusable.
 * Exported for the publish-time validator, so "what counts as a URL" is decided
 * in exactly one place.
 *
 * @param {string|{url?: string, ref?: string, name?: string}} entry
 * @returns {{ $id: string, fields: { url: string } | { ref: string } } | null}
 */
export function extensionDeclaration(entry) {
  if (entry && typeof entry === 'object') {
    if (typeof entry.url === 'string' && entry.url)
      return { $id: entry.url, fields: { url: entry.url } }
    const named = entry.ref || entry.name
    return typeof named === 'string' && named
      ? { $id: named, fields: { ref: named } }
      : null
  }
  if (typeof entry !== 'string' || !entry) return null
  return isExtensionUrl(entry)
    ? { $id: entry, fields: { url: entry } }
    : { $id: entry, fields: { ref: entry } }
}

/** True for declarations that are URLs rather than names — absolute or site-relative. */
export function isExtensionUrl(decl) {
  return (
    typeof decl === 'string' &&
    (/^https?:\/\//.test(decl) || decl.startsWith('/'))
  )
}

/** True only for the site-relative form, which no backend-hosted site can serve. */
export function isSiteRelativeExtensionUrl(decl) {
  return typeof decl === 'string' && decl.startsWith('/')
}

// The collection DECLARATIONS carried inside site-content `info`-adjacent metadata.
// Merges the co-located `collections.yml` (the home for file-based decls) over the
// legacy `site.yml::collections` (kept for remote `url:` sources + back-compat).
/**
 * The site's collection DECLARATIONS as `$`-records.
 *
 * ⛔ IDENTITY IS KEYED BY `name`, AND IT HAS TO BE.
 *
 * Every other item on this entity gets its `$uuid` from a map keyed by the file it
 * was projected to — but a collection declaration has no file of its own: they all
 * come from one `collections/collections.yml`. So a path-keyed map has no shape a
 * declaration could occupy, nothing is ever recorded for one, and every push re-sent
 * this whole section uuid-less. The backend refuses that (an all-blank section over
 * stored items would delete every stored row), which is why `push` worked once and
 * every push after it was refused. Measured 2026-08-29; collab framework-backend-812b.
 *
 * ⭐ `name` is the right key and not merely the available one — the backend enforces
 * `unique_field(name, scope: section)` on this section, and it is the join key its
 * `resolve_collection_model` matches and the `/data/{name}.json` serve segment. An
 * author-facing rename is `label`, so the key does not move under either lane.
 *
 * ⛔ NOT `$id`, though it happens to hold the same string. `$id` is a payload-local
 * handle the backend skips on parse and never stores, correlated by submission index
 * rather than by value — keying on it would key on something that exists only inside
 * our own outgoing document.
 *
 * ⚠️ Because `name` IS the identity, renaming a collection is by design
 * indistinguishable from delete-plus-create. Rename one of two and the mix passes;
 * rename every collection at once and the section goes all-blank and is refused.
 * That is the semantics, not a defect.
 *
 * ⛔ DO NOT TRIM THE FIELDS BELOW, even the ones the backend never reads.
 *
 * The backend destructures exactly two — `name` and `schema` — and projects none of
 * this Section into a published payload, so the rest read as dead weight. ⛔ THEY ARE
 * OURS, AND THAT IS REASON ENOUGH: `excerpt`, `deferred`, `detailUrl` and `queryable`
 * are read across FRAMEWORK's own runtime, build and kit — `useQueryable`
 * is a public hook a foundation calls to render a filter UI. They drive the file
 * lane, where they work. "The backend does not read it" was never an argument that
 * nothing reads it.
 *
 * ⚠️ There may be a second reason, and it is NOT ours to assert. Backend states that
 * their decl type reaches the app lane verbatim and that their reconcile
 * replaces an item's `data` wholesale with no field-grain merge — from which an
 * omitted field the EDITOR set would be destroyed on the next push. The mechanism is
 * their code and theirs to state. **Whether the editor reads or writes this decl at
 * all is FRONTEND's, and neither framework nor backend has established it.** Treat it
 * as an open hypothesis, not a fact — see the doc below.
 *
 * ⚠️ Separately measured: framework does not emit `label` and has no such collection
 * field — ours belongs to a `folders:` BRANCH. Backend's fixture asserted we mirror a
 * `site.yml collections.<name>.label`; no such field has ever existed, and they have
 * corrected it.
 *
 * ⇒ Full record, including what is established vs merely claimed:
 * `kb/framework/build/collections-decl-open-questions.md`.
 *
 * @param {object} declarations resolved collection declarations, keyed by name
 * @param {Object<string,string>} [uuids] `name` → backend `$uuid`, from a push
 *        response or a pull. Absent on a first sync, where minting is correct.
 */
// ⛔ KEYS THAT MUST NOT REACH THE WIRE. Everything else on an authored declaration
// is emitted, including fields this build does not model — see the note in
// `queriesNested`. Enumerated here rather than inverted into an allowlist
// because framework OWNS this vocabulary and can therefore enumerate it
// truthfully; it does not own the Model's, and cannot.
//
// Sources, both framework's own: `site/query-processor.js::parseQueryConfig`
// (the decl parser) and `site/queries-config.js` (normalization). Pinned by
// `tests/uwx-decl-unmodelled-fields.test.js`, which fails if either gains a field
// that is neither emitted nor listed here.
// Authored keys the explicit block in `queriesNested` already consumes. Kept
// separate from the framework-local set below because these DO reach the wire —
// just under a wire spelling. ⚠️ `detailUrl` is the one that matters: it is emitted
// as `detail_url`, so a pass-through keyed on "is it already in `data`?" does not
// see it and the field rides TWICE. Measured 2026-08-29, in the first draft of this
// very change — and the push test missed it because both its controls (`limit`,
// `schema`) keep their names.
const DECL_EMITTED_ABOVE = new Set([
  'source',
  'schema',
  'sort',
  'where',
  'limit',
  'excerpt',
  'deferred',
  'detailUrl',
  'queryable'
])

const DECL_NOT_ON_WIRE = new Set([
  // Identity — rides as the record's own `name`, not inside `data`.
  'name',
  // Folded into `source` above.
  'path',
  'url',
  // Folded into `schema` above (the migration synonym).
  'model',
  // Build state: whether the AUTHOR asked for the schema or the subfolder-name
  // convention supplied it. Decides hard-error vs soft-skip during sync;
  // `collections-config.js::toConfigQueries` strips it downstream too.
  'schemaExplicit',
  // ⭐ FRAMEWORK-LOCAL, and the one that proves the rule. `route:` is a real
  // authored field — `parseQueryConfig` reads it, and `collectItems` composes
  // each item's link as `<route>/<slug>` — but the backend's Model has no slot for
  // it, so emitting it would be sending build-time config to a store that validates
  // against a declared schema. Measured 2026-08-29: a first version of this change
  // passed unknown keys through blindly and would have started sending `route` from
  // every site that declares one.
  'route',
  // Legacy predicate, translated to the canonical `where` upstream. No legacy
  // fields on the wire.
  'filter'
])

function queriesNested(declarations, uuids = null) {
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
    // ⛔ EMIT WHAT WE DO NOT MODEL. The decl's field set is the BACKEND's Model
    // (this document mirrors `@uniweb/site-content` — see the lane header), and
    // their reconcile replaces `data` WHOLESALE with no field-grain merge. So an
    // allowlist here does not merely fail to send an unmodelled field: it DESTROYS
    // whatever was stored under it, silently, on every push.
    //
    // ⚠️ Measured 2026-08-29: the Model declares ELEVEN decl fields and this emitter
    // knew ten. The eleventh is `label`, which framework has no authoring concept
    // for — `label` in framework is a `folders:` BRANCH field (`{segment, label,
    // entries}`), not a property of a collection.
    //
    // ⭐ `label` is the instance, not the defect. Any field the Model gains that we
    // have not taught this function repeats it, and nothing reports the loss. Hence
    // a DENY-list: framework can enumerate its own vocabulary truthfully and cannot
    // enumerate the Model's, so the safe inversion is "withhold what is ours".
    //
    // ⚖️ We do NOT warn on an unrecognized key. Framework cannot tell a valid Model
    // field from a typo — only the server can, and it validates every write against
    // the declared schema. Its rejection is the honest signal; a guess from here
    // would cry wolf on every legitimate new field. Same rule and same reasoning as
    // `site/fetch-shapes.js`: drop only what is DERIVABLE, never what is merely
    // unrecognized.
    for (const [key, value] of Object.entries(d)) {
      if (value === undefined) continue
      if (DECL_EMITTED_ABOVE.has(key) || DECL_NOT_ON_WIRE.has(key)) continue
      data[key] = value
    }
    const rec = withIdentity(name, { name, ...data })
    const uuid = uuids?.[name]
    if (typeof uuid === 'string' && uuid) rec.$uuid = uuid
    out.push(rec)
  }
  return out
}

// ── `services` + `secrets` — a site's own service records ─────────────────────
//
// ⭐ THE FILE KEYS ARE `$services` / `$secrets`, NOT `services` / `secrets`, and the
// `$` is load-bearing rather than decorative. `site.yml::services` is ALREADY TAKEN,
// on the other lane: the bundle lane spreads site.yml whole into the payload, so a
// `services:` block there lands at `config.services` — the HOST tier — which is the
// documented way to simulate a host locally (`kit/src/utils/submitTarget.js`).
// Reusing the name would give one key two meanings that differ per lane, which is
// the shape of bug nobody finds.
//
// `$` already means "backend-scoped, round-tripped, not hand-authored" in this file
// (`$uuid`, `$org`, `$backend`), and that is exactly what these are: a service's
// config is bound where the service is provisioned, and arrives here by `pull`.
//
// ⚖️ WHAT THESE ARE NOT. A site's OWN service declarations — `search:`, `submit:`,
// `assistant:`, `tracking:` — stay top-level `info.*` keys and are untouched. Those
// are authored, they resolve at the SITE tier (`config.<name>`, first choice in
// `@uniweb/core`'s `resolveService`), and moving them here would flip them to the
// host tier, where a block's mere presence declines every service it does not name.
// These Sections carry the services a site is PROVISIONED with — `api` above all,
// which has no file-authored form because it is bought, not declared.
//
// ⛔ ABSENT IS NOT EMPTY, and the difference is destructive. The Section is
// REPLACED by what we send, so `[]` means "drop every stored config row" while a
// missing key means "I am not telling you about this". A project that has never
// pulled has no `$services`, and its ordinary push must not read as a request to
// wipe a service the operator configured in the app. So: emit the Section only when
// the file declares the key. Clearing is available and explicit — `$services: []`.
//
// ⚠️ The push gate is NOT what makes this safe, though it usually catches it: its
// tokens live in a gitignored per-clone cache, so a fresh clone pushes
// unconditionally. Correctness has to sit here.

/**
 * `$services` / `$secrets` → Section records, or undefined when the key is absent.
 *
 * ⭐ PASSTHROUGH, NOT AN ALLOWLIST — the same rule and the same reason as
 * `queriesNested` above. The field set belongs to the backend's Model, a service's
 * `config` is opaque and per-service, and reconcile replaces `data` wholesale — so
 * enumerating keys here would not merely fail to send a field we do not know, it
 * would DESTROY whatever is stored under it on every push. Framework can enumerate
 * its own vocabulary and cannot enumerate theirs; withhold ours, forward the rest.
 *
 * @param {*} declared - the raw `$services` / `$secrets` value from site.yml
 * @param {(entry: object) => string|null} identify - the record's stable `$id`
 * @param {string} label - the key name, for the one warning below
 * @returns {object[]|undefined}
 */
function serviceRecords(declared, identify, label) {
  if (declared === undefined || declared === null) return undefined
  if (!Array.isArray(declared)) {
    console.warn(
      `uwx/site: \`${label}:\` must be a list of entries — ignoring a ${typeof declared}.`
    )
    return undefined
  }
  const out = []
  for (const entry of declared) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const id = identify(entry)
    // ⚠️ `name` is OUR OWN declared-required field, so a warning here is honest —
    // unlike an unrecognized key, which only the server can judge. And the loss is
    // otherwise invisible: on a replaced Section a dropped entry reads as a
    // deliberate removal of its config row.
    if (!id) {
      console.warn(
        `uwx/site: \`${label}:\` has an entry with no \`name\` — skipping it. On a replaced ` +
          'section a dropped entry reads as a deliberate removal of its config.'
      )
      continue
    }
    const data = {}
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) continue
      data[key] = value
    }
    out.push(withIdentity(id, data))
  }
  return out
}

/** One service per `name` — the same keyspace `config.services` uses at runtime. */
function servicesNested(siteYml) {
  return serviceRecords(
    siteYml.$services,
    (e) => (typeof e.name === 'string' && e.name ? e.name : null),
    '$services'
  )
}

/**
 * One secret per `(service, name)` — the pair the backend merges on. A site-level
 * secret belongs to no service, so `service` is optional and the handle degrades to
 * the bare name.
 *
 * ⛔ `value` IS FORWARDED VERBATIM, INCLUDING A LITERAL. A pulled secret carries the
 * marker `#ref` meaning "a secret is set", never the value, and pushing the marker
 * back means "leave it alone" — so the ordinary round trip sends nothing sensitive.
 * A literal typed into the file is refused by the server, which is where that
 * judgement belongs; framework does not strip it, because silently dropping a value
 * an author typed would leave them believing a secret was set.
 */
function secretsNested(siteYml) {
  return serviceRecords(
    siteYml.$secrets,
    (e) => {
      if (typeof e.name !== 'string' || !e.name) return null
      return typeof e.service === 'string' && e.service
        ? `${e.service}:${e.name}`
        : e.name
    },
    '$secrets'
  )
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
 * @param {string} [opts.sourceLocale] - localized-field wrap locale. Defaults to
 *        the site's effective default locale (`defaultLanguage || languages[0] ||
 *        'en'` — the shared `resolveDefaultLocale` rule), NOT a bare 'en'.
 * @returns {Promise<object>} the section-keyed `$`-document:
 *        `{ $uuid?, $id, $model, info, pages, layout_sections, extensions, queries }`
 */
export async function siteProjectToDocument(siteRoot, opts = {}) {
  const siteYml = await readYamlFile(join(siteRoot, 'site.yml'))
  const sourceLocale = opts.sourceLocale || resolveDefaultLocale(siteYml)
  if (!siteYml.name) {
    throw new Error('uwx/site: site.yml::name is required')
  }
  if (!siteYml.foundation || typeof siteYml.foundation !== 'string') {
    throw new Error(
      'uwx/site: site.yml::foundation (a reference string) is required — ' +
        'it maps to the required @uniweb/site-content info.foundation'
    )
  }
  // Language-config contract: warnings surface (dangling publish codes,
  // legacy entry shapes); errors — nothing publishable / default not
  // publishable — hard-error at push, same as the static build does at
  // build/deploy (uwx-format.md → "Per-locale publish readiness").
  const langValidation = validateLanguageConfig(siteYml)
  for (const { message } of langValidation.warnings) {
    console.warn(`uwx/site: ${message}`)
  }
  if (langValidation.errors.length > 0) {
    throw new Error(
      'uwx/site: invalid language configuration:\n' +
        langValidation.errors.map((e) => `  - ${e.message}`).join('\n')
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
  // `name` is an identity LABEL (the author's own handle for the site, like a
  // filename) — single-language by nature, and it must ALWAYS render: under locale
  // projection a localized field with no entry for the requested locale is dropped,
  // so a `{en:…}`-only name would vanish. It therefore ships as a plain string, never
  // a localized `{lang:value}` map. Genuine content fields (`description` below, page
  // title/slug/label/keywords, the body) stay localized. (uwx-format.md → identity-label names.)
  info.name = siteYml.name
  setIf(info, 'description', localizeScalar(siteYml.description, sourceLocale, translations))
  if (themeYml && Object.keys(themeYml).length > 0) info.theme = themeYml
  setIf(info, 'languages', siteYml.languages)
  setIf(info, 'default_language', siteYml.defaultLanguage)
  // Publish intent (site.yml `publishLanguages:`) rides VERBATIM — dangling
  // codes included. Sync carries the full working set; only *publish* filters
  // (backend projection / static-build filter). The verbatim carry is what
  // preserves a locale's publish intent across a remove + re-add in
  // `languages:` (uwx-format.md → "Per-locale publish readiness").
  setIf(info, 'publish_languages', siteYml.publishLanguages)
  // `foundation` (required) — the verbatim `site.yml::foundation` string
  // (registry ref / URL / local path), the round-trip source of truth.
  info.foundation = siteYml.foundation
  setIf(info, 'base', siteYml.base)
  // favicon — a verbatim URL/path string. ⚠️ This comment claimed "the kit
  // resolves it, like other media refs" until 2026-08-17; measured, `favicon`
  // appears nowhere in `kit/src` or `runtime/src`. The real consumer is
  // `build/src/site/plugin.js`, which injects a `<link>` into `index.html` at
  // BUILD time — from `config.favicon` verbatim, else by auto-detecting
  // `public/favicon.{svg,ico,png}`. So it is a build-time injection, not a
  // runtime resolve, and anything giving the favicon a resolvable asset
  // reference has to act there rather than in the runtime.
  //
  // `assets` is a build-DERIVED upload manifest, not authored config, so it
  // is never produced from / projected to the site files.
  setIf(info, 'favicon', siteYml.favicon)
  // Site-level SEO/social metadata — the same shape as page.yml's `seo:` + the
  // top-level `keywords`, hoisted to the site root so the homepage social card
  // and default keywords exist for any share/SSR/crawler. `seo` rides verbatim
  // as authored config (round-trips like favicon); `keywords` is a localized
  // list (like page keywords).
  setIf(info, 'seo', siteYml.seo)
  setIf(info, 'keywords', localizeScalarList(siteYml.keywords, sourceLocale, translations))
  setIf(info, 'head_html', headHtml)
  setIf(info, 'fetcher', siteYml.fetcher)
  setIf(info, 'build', siteYml.build)
  setIf(info, 'search', siteYml.search)
  // `submit` — where this site's forms send submissions. Same family as
  // `fetcher`/`search`: the site declares it, the runtime reads it, and it
  // round-trips verbatim. It has to be listed HERE because this lane is an
  // explicit allowlist while the bundle lane spreads all of site.yml — without
  // the line a `submit:` block works on a static host and vanishes silently on
  // the synced lane, which is the worst shape a config bug can take.
  setIf(info, 'submit', siteYml.submit)
  // `agents` — the projections opt-out + route exclusions. Carried because the
  // app is a second PUBLISHER of projections and derives them from stored
  // content: without this block it cannot see `agents: false` or
  // `agents.exclude`, so an author's opt-out is silently reversed and an
  // excluded branch becomes both discoverable AND summarized by the index.
  // (The CLI lane reads site.yml directly and honors it either way.)
  setIf(info, 'agents', siteYml.agents)
  // `assistant` — the site's own declaration for an AI assistant: where it
  // lives (`endpoint`, read by kit's `resolveService`) plus authored settings a
  // host reads (`system` persona, model hints). Same family as
  // `search`/`submit`, and here for the reason spelled out above them — the
  // bundle lane spreads all of site.yml while this one is an allowlist, so
  // without this line the block works on a static host and vanishes silently
  // on the synced lane.
  //
  // ⚠️ That is not hypothetical: this replaces `intelligence.yml`, a SEPARATE
  // file, which needed a bespoke line in each lane and got one in only the
  // bundle lane — so an authored persona never reached a hosted site at all.
  // A key inside site.yml cannot repeat that, because only this lane needs a
  // line.
  //
  // ⛔ Credentials are stripped, not trusted — see `stripCredentials`.
  setIf(info, 'assistant', stripCredentials(siteYml.assistant, 'assistant'))
  // `tracking` — where this site's usage events go (`endpoint`, read by the
  // runtime through `resolveService`, plus `consent:`). Same family as
  // `search`/`submit`/`assistant` and here for the same reason: the bundle lane
  // spreads all of site.yml while this one is an allowlist, so without this line
  // an authored `tracking:` works on a static host and vanishes silently on the
  // synced lane.
  //
  // ⛔ Credentials stripped like `assistant`. A collector that wants a write key
  // is a real shape, and this block is published world-readable — but note the
  // strip only reaches a KEYED FIELD: a key embedded in the endpoint URL itself
  // (`https://collector/e?key=…`) is invisible here and is disclosed. The host's
  // secret store is the only right home either way.

  setIf(info, 'tracking', stripCredentials(siteYml.tracking, 'tracking'))
  // ⛔ `api` IS DELIBERATELY NOT HERE, and this note exists because every comment
  // above it argues the opposite — three services are on this allowlist precisely so
  // an authored block cannot work on a static host and vanish on the synced one.
  // Without this paragraph the next reader adds the missing fourth line and calls it
  // a bug fix.
  //
  // ⭐ `api` is the one service a site does not AUTHOR. It is a real backend that is
  // provisioned and paid for, so its address is the host's to supply — it arrives as
  // `config.services.api` and `@uniweb/api` reads it there (`resolveBase`). An
  // authored `api:` is the SITE tier, which outranks the host permanently.
  //
  // ⇒ Carrying it would turn a local-dev override into a production one the moment
  // someone pushed: the host would store `info.api` and serve it back as `config.api`,
  // which wins over the address of the backend the site actually has. The vanish on
  // this lane is the correct behaviour, not the bug the comments above describe —
  // there, a dropped block leaves a site with NO endpoint; here it leaves the site
  // with the RIGHT one.
  //
  // The provisioned record rides the `$services` section instead (see servicesNested).
  setIf(info, 'paths', siteYml.paths)
  setIf(info, 'data', siteYml.data ?? siteYml.fetch)
  // ⛔ `app` IS RETIRED — do not reintroduce it, in either direction. It carried an
  // opaque uuid naming a separate entity a host bound to the site; that entity is
  // gone, a site's services belong to the site itself, and NOTHING replaces the key.
  //
  // ⚠️ Removing the emit is the FIRST of two steps and the order is forced: a host
  // refuses a key it does not declare, so the producer stops sending before the
  // declaration is dropped. The reverse order fails every push in between.
  //
  // ✅ Unobservable, because nothing ever originated the key — no template writes
  // `site.yml::app`. The line round-tripped a value that was never set.
  // (uwx-format.md → info.app.)
  // `template: true` designates this site as a clonable SITE-TEMPLATE: on push the
  // backend applies a clonability designation to this site-content entity (it is
  // NOT a registry artifact). Verbatim; absent → a normal (non-template) site.
  setIf(info, 'template', siteYml.template)

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
  // locales/freeform/**). A non-invasive post-pass over the built tree.
  //
  // Runs for EVERY site, including single-locale ones: `content` declares
  // `localized: true`, so it ships as `{ [sourceLocale]: doc }` whatever the
  // language count. Guarding this on `targetLocales.length` is what used to send
  // a bare doc from single-locale sites — see localizeContentDoc for why one
  // field with two shapes is a store that cannot validate its own declaration.
  await localizeContentTree(pages, layoutSections, sourceLocale, targetLocales, translations, siteRoot)

  // Collection DECLARATIONS — the merged collections.yml + site.yml::collections
  // config (the records themselves are separate entities; this is just the config).
  const colConfig = await resolveQueriesConfig(siteRoot, { siteYml })

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
  // ⭐ THE SECTION IS `queries`. Backend renamed it on `@uniweb/site-content`
  // (2026-08-29) and explains it as named queries — content that is RESOLVED AT
  // RUNTIME rather than rendered, which is framework's own model of it
  // (`records-model.md` §1: a query is second-order site content).
  //
  // ⚠️ `queriesNested` keeps its name. §2's rule: rename what an author or a
  // consumer sees, leave the identifier alone.
  doc.queries = queriesNested(colConfig.declarations, opts.queryUuids)
  // Emitted ONLY when the file declares the key — see the header above
  // `serviceRecords`: on a replaced Section, absent and empty are different
  // requests and one of them is destructive.
  const services = servicesNested(siteYml)
  if (services) doc.services = services
  const secrets = secretsNested(siteYml)
  if (secrets) doc.secrets = secrets
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

/**
 * Record the org the site was CREATED under (`site.yml::$org`), beside `$uuid`.
 *
 * The org is consumed at exactly one moment — the `as_org` on the create that
 * mints `$uuid` — and after that the uuid carries the ownership binding. So this
 * is not a knob the backend re-reads; it is the answer to *"whose workspace is
 * this site's storage charged to?"*, which `$uuid` alone cannot answer and which
 * otherwise costs a backend round-trip (or is simply unknowable from the repo).
 *
 * Stored as the BARE handle, never `@handle`: `upsertYamlScalar` writes the value
 * verbatim, and `@` is a reserved YAML indicator, so a plain scalar may not start
 * with one — `$org: @acme` is a parse error. The bare form is also the canonical
 * one everywhere else (`deriveScope` returns it, `createOrg` echoes it as
 * `org.handle`, `validateHandle` validates it); the `@` is display sugar the
 * reader re-adds.
 *
 * Safe to add to `site.yml` because the sync lane is an explicit allowlist
 * (`info.*` above is built key by key), so this never rides the wire.
 *
 * ⛔ NOT `deploy.yml`, though that file already holds the bound `backend` and the
 * two look like the same class of fact. Four reasons, and the first is the one that
 * settles it:
 *
 *  1. CARDINALITY. `deploy.yml` is multi-TARGET and `backend` sits *under* a target,
 *     so its shape says "this may vary per target." An org may not: one site has one
 *     owning org, fixed at create and preserved on replace. `$org` is a property of
 *     `$uuid`, which is singular and lives here — filing it under a target would
 *     encode a freedom that does not exist.
 *  2. WHO WRITES. Three paths mint a site (`ensureSiteExists`, the media-less push's
 *     content-lane create, and `clone` seeding an existing one) and **none of them
 *     write `deploy.yml`** — only `deploy` and `publish` call `recordLastDeploy`. The
 *     record would exist or not depending on which verb the developer reached for.
 *  3. SUPPRESSIBLE. `recordLastDeploy` is a no-op under `autoSave: off` / `--no-save`.
 *     Turning off deploy *receipts* would silently drop an *ownership* record.
 *  4. SEMANTICS. `deploy.yml` describes the act of shipping (`lastDeploy` is a
 *     receipt) and is optional entirely. But `push` creates a site and never
 *     publishes — a site can exist, be owned, and accrue storage charges without
 *     ever being deployed. Ownership does not belong in a record of a deploy that
 *     may not have happened.
 *
 * `backend` answers *where this ships*; `$org` answers *whose this is*.
 *
 * @param {string} siteRoot
 * @param {string} handle - the bare org handle (no leading `@`)
 * @returns {boolean} true if site.yml changed
 */
export function writeSiteOrg(siteRoot, handle) {
  return upsertYamlScalar(join(siteRoot, 'site.yml'), '$org', handle)
}

/**
 * Record the backend this project SYNCS WITH (`site.yml::$backend`), beside `$uuid`/`$org`.
 *
 * ⭐ It is not a tag on the site uuid — it is the project's **sync scope**. Four surfaces
 * hold backend-minted identity, and this one fact is what makes all of them meaningful:
 * `site.yml::$uuid`, every collection record's `$uuid` in its own source file,
 * `assets.json`, and `.uniweb/sync-cache.json`. Change the backend and every one of them
 * is foreign at once — which is why a mismatch is a stop, not a fallback
 * (`assertSiteBackendScope` in the CLI).
 *
 * ⛔ **Written ONLY for a non-default backend.** The 98% case stays out of the file, and an
 * absent value reads as the default — correct both for a project written before this key
 * existed and for one synced against the default. Callers decide; this writer does not know
 * the CLI's default. See `recordSiteBackend` (cli/src/backend/site-sync.js), which is where
 * the "is it the default?" test lives.
 *
 * ⚠️ **The name is load-bearing. Five alternatives were considered and rejected (2026-08-24);
 * do not re-propose one.** `origin` is wrong twice over — a site HAS an origin (its own
 * served domain), and this lane is git-modeled, where `origin` names a remote rather than a
 * URL. `remote` implies a multiplicity this design closes. `hosting` and `platform` name the
 * hosting edge, which this package has no client for. `host` collides with
 * `deploy.yml::targets.<n>.host` (the deploy adapter). A `uuid: <id>@<backend>` suffix was
 * rejected too: it would make "this never reaches the backend" a discipline at every read
 * site instead of a property, and `siteProjectToDocument` assigns `$uuid` straight onto the
 * wire document.
 *
 * Safe as a plain YAML scalar: a URL's `:` is followed by `/` or a digit, never a space, so
 * it needs no quoting (verified against js-yaml for apex, `localhost:8080` and host:port+path
 * forms, 2026-08-24). This is the same class of hazard as `$org`'s leading `@`, which is
 * stripped for exactly that reason — but it lands on the safe side.
 *
 * @param {string} siteRoot
 * @param {string} origin - a bare origin, no trailing slash
 * @returns {boolean} true if site.yml changed
 */
export function writeSiteBackend(siteRoot, origin) {
  return upsertYamlScalar(join(siteRoot, 'site.yml'), '$backend', origin)
}
