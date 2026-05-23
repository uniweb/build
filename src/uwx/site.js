// Map a file site project to one `@uniweb/site-content` entity, then to a
// `subtype: entity` .uwx.
//
// SOURCE LAYER: the content-collector's return is flattened and lossy for
// `mode` / `order` / the page tree, so we RE-WALK the source. We reuse
// content-collector's *pure* per-file helpers (markdown→ProseMirror via
// processMarkdownFile, ordering, mode detection) so those semantics stay
// identical to a normal build — only the directory/mode/order *walk* is
// ours (the part the flattened return loses).
//
// Every entity/item uuid comes from a pluggable resolver (identity.js) keyed
// by something that survives edits, so a sidecar-backed re-export UPDATES
// rather than DUPLICATES (import is idempotent by uuid).
//
// Mapped to the @uniweb/site-content entity type's six Sections: info · pages ·
// page_sections · layout_sections · extensions · collections.
// `info.foundation_ref` carries the verbatim `site.yml::foundation` string
// (the round-trip source of truth); the optional `foundation` entity_ref is
// left absent — it is resolved on import.
//
// v0 scope (stated, not silent): deferred are `@`-prefix `nest:` *hierarchy*
// (child sections land flat under their page — no data loss, only nesting
// structure is not reconstructed), folder-mode `.md`-as-pages
// (document/blog-list profile), `paths:` mounts, versioned scopes, and
// media/asset bytes (favicon/assets — carried out of band).

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import {
  readYamlFile,
  readFolderConfig,
  isMarkdownFile,
  isIgnoredFolder,
  parseNumericPrefix,
  compareFilenames,
  parseWildcardArray,
  applyWildcardOrder,
  processMarkdownFile,
} from '../site/content-collector.js'
import { SITE_CONTENT_TYPE_UUID } from './entity-types.js'
import { emitEntityPackage } from './package.js'
import { localize, LOCALIZED_FIELD_ASSUMPTION } from './localize.js'
import { mintResolver, sidecarResolver, SIDECAR_RELPATH } from './identity.js'

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

async function walkPages(ctx, dirPath, chainToParent, parentSlugPath, inheritedMode, parentConfig, isRoot) {
  const { siteRoot, id, siteIndex, sourceLocale, acc } = ctx
  const folders = await orderedSubfolders(dirPath, inheritedMode, parentConfig)
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
    // Stable key: frontmatter `id:` is the rename-survival anchor. Fallback
    // to the slug path (breaks on rename/move — documented v0 limitation).
    const pageKey = data.stable_id
      ? `page:id:${data.stable_id}`
      : `page:path:${slugPath}`

    acc.pages.push({
      uuid: id.item(pageKey),
      section: 'pages',
      parent_section: null,
      parent_path: chainToParent.length > 0 ? chainToParent : null,
      data,
      order_number: i,
    })

    // The chain whose last tuple identifies THIS page item — used as the
    // parent_path of both its sections and its child pages.
    const childChain = [...chainToParent, ['pages', i]]

    if (mode === 'page') {
      const mdFiles = (await readdir(f.path))
        .filter(isMarkdownFile)
        .sort(compareFilenames)
      for (let k = 0; k < mdFiles.length; k++) {
        const file = mdFiles[k]
        const bare = parse(file).name
        const stableDefault = parseNumericPrefix(bare).name
        const { section } = await processMarkdownFile(
          join(f.path, file),
          String(k + 1),
          siteRoot,
          stableDefault
        )
        const secId = section.stableId || `@${k}`
        acc.sections.push({
          uuid: id.item(`${pageKey}::sec:${secId}`),
          section: 'page_sections',
          parent_section: 'pages',
          parent_path: childChain,
          data: mapSectionData(section),
          order_number: k,
        })
      }
    }

    await walkPages(
      ctx,
      f.path,
      childChain,
      slugPath,
      f.internalMode,
      f.config,
      false
    )
  }
}

async function collectLayoutSections(layoutDir, siteRoot, id) {
  if (!existsSync(layoutDir)) return []
  const items = []
  let order = 0

  async function addArea(filePath, layoutName, area) {
    const { section } = await processMarkdownFile(
      filePath,
      String(order + 1),
      siteRoot,
      area
    )
    const stable = section.stableId || String(order)
    items.push({
      uuid: id.item(`layout:${layoutName}/${area}:${stable}`),
      section: 'layout_sections',
      parent_section: null,
      parent_path: null,
      data: { layout_name: layoutName, area, ...mapSectionData(section) },
      order_number: order++,
    })
  }

  const entries = await readdir(layoutDir, { withFileTypes: true })
  // Root *.md → the "default" layout's areas.
  const rootMd = entries
    .filter((e) => e.isFile() && isMarkdownFile(e.name))
    .map((e) => e.name)
    .sort(compareFilenames)
  for (const file of rootMd) {
    await addArea(
      join(layoutDir, file),
      'default',
      parseNumericPrefix(parse(file).name).name
    )
  }
  // <layoutName>/*.md → that named layout's areas.
  for (const e of entries) {
    if (!e.isDirectory() || isIgnoredFolder(e.name)) continue
    const sub = join(layoutDir, e.name)
    const md = (await readdir(sub))
      .filter(isMarkdownFile)
      .sort(compareFilenames)
    for (const file of md) {
      await addArea(
        join(sub, file),
        e.name,
        parseNumericPrefix(parse(file).name).name
      )
    }
  }
  return items
}

function collectExtensions(siteYml, id) {
  const ext = siteYml.extensions
  if (!Array.isArray(ext)) return []
  const items = []
  for (let i = 0; i < ext.length; i++) {
    const url = ext[i]
    if (typeof url !== 'string') continue // object form deferred (v0)
    items.push({
      uuid: id.item(`ext:${url}`),
      section: 'extensions',
      parent_section: null,
      parent_path: null,
      data: { url },
      order_number: i,
    })
  }
  return items
}

function collectCollections(siteYml, id) {
  const col = siteYml.collections
  if (!col || typeof col !== 'object' || Array.isArray(col)) return []
  const items = []
  let i = 0
  for (const [name, decl] of Object.entries(col)) {
    const d = decl && typeof decl === 'object' ? decl : {}
    const data = { name }
    const source = d.path
      ? { path: d.path }
      : d.url
        ? { url: d.url }
        : d.source
    setIf(data, 'source', source)
    setIf(data, 'sort', d.sort)
    setIf(data, 'filter', d.filter)
    setIf(data, 'where', d.where)
    setIf(data, 'limit', d.limit)
    setIf(data, 'excerpt', d.excerpt)
    setIf(data, 'deferred', d.deferred)
    setIf(data, 'detail_url', d.detailUrl)
    setIf(data, 'queryable', d.queryable)
    items.push({
      uuid: id.item(`col:${name}`),
      section: 'collections',
      parent_section: null,
      parent_path: null,
      data,
      order_number: i++,
    })
  }
  return items
}

/**
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {object} [opts.idResolver]  - identity resolver. Default: mint
 *                                      (submit-once, side-effect-free).
 * @param {string} [opts.entityUuid]  - explicitly pin the entity uuid
 *                                      (overrides the resolver).
 * @param {string} [opts.ownerUuid]   - informational owner claim; default
 *                                      null (an importer's default mode
 *                                      discards it and binds to the caller).
 * @param {string} [opts.sourceLocale]- localized-wrap locale (default "en").
 * @returns {Promise<object>} entity ready for emitEntityPackage
 */
export async function siteProjectToEntity(siteRoot, opts = {}) {
  const id = opts.idResolver || mintResolver()
  const sourceLocale =
    opts.sourceLocale || LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale
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

  const acc = { pages: [], sections: [] }
  const pagesPath = siteYml.paths?.pages
    ? join(siteRoot, siteYml.paths.pages)
    : join(siteRoot, 'pages')
  if (existsSync(pagesPath)) {
    await walkPages(
      { siteRoot, id, siteIndex: siteYml.index, sourceLocale, acc },
      pagesPath,
      [],
      '',
      'sections', // site profile default (page mode)
      siteYml, // top-level `pages:` wildcard source
      true
    )
  }

  const layoutDir = siteYml.paths?.layout
    ? join(siteRoot, siteYml.paths.layout)
    : join(siteRoot, 'layout')
  const layoutSections = await collectLayoutSections(layoutDir, siteRoot, id)

  const items = [
    {
      uuid: id.item('info'),
      section: 'info',
      parent_section: null,
      parent_path: null,
      data: info,
      order_number: null,
    },
    ...acc.pages,
    ...acc.sections,
    ...layoutSections,
    ...collectExtensions(siteYml, id),
    ...collectCollections(siteYml, id),
  ]

  return {
    uuid: opts.entityUuid || id.entity(SITE_ENTITY_KEY),
    model_uuid: SITE_CONTENT_TYPE_UUID,
    owner_uuid: opts.ownerUuid ?? null,
    unit_uuid: null,
    meta: {},
    items,
  }
}

/**
 * Site project -> a one-entity `@uniweb/site-content` .uwx Buffer.
 *
 * @param {string} siteRoot
 * @param {object} [opts]
 * @param {boolean|string} [opts.sidecar] - enable the syncable round trip.
 *        `true` → `<siteRoot>/.uniweb/uwx-ids.json`; a string → that path.
 *        Default off (submit-once); the CLI defaults it on.
 * @param {string} [opts.entityUuid] @param {string} [opts.ownerUuid]
 * @param {string} [opts.sourceLocale] @param {object} [opts.exporter]
 * @param {string} [opts.exportedAt]
 * @returns {Promise<Buffer>}
 */
export async function emitSitePackage(siteRoot, opts = {}) {
  let id = opts.idResolver
  if (!id && opts.sidecar) {
    const path =
      typeof opts.sidecar === 'string'
        ? opts.sidecar
        : join(siteRoot, SIDECAR_RELPATH)
    id = sidecarResolver(path)
  }
  if (!id) id = mintResolver()

  const entity = await siteProjectToEntity(siteRoot, { ...opts, idResolver: id })
  id.flush()

  return emitEntityPackage({
    entities: [entity],
    modelsRequired: [
      { uuid: SITE_CONTENT_TYPE_UUID, name_at_export: '@uniweb/site-content' },
    ],
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })
}
