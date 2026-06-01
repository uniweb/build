// Project writer — file-projection primitives for writing a site's canonical
// source files back from in-memory entity/section data.
//
// Projecting backend (sync) state to disk needs to resolve, merge, and
// idempotently write a site's source files: section `.md` files (frontmatter +
// markdown body), `theme.yml`, `site.yml`, and collection record files. These are
// the projection primitives only — file resolution, frontmatter-aware section
// writes, config merges, idempotent atomic writes. All sync, matching the uwx
// siblings (backfill.js, folder.js); the body serialization reuses
// @uniweb/content-writer and the frontmatter split reuses collection-source's
// parseFrontmatter — no new copies of either.

import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import yaml from 'js-yaml'
import { proseMirrorToMarkdown, serializeFrontmatter } from '@uniweb/content-writer'
import { parseFrontmatter } from './collection-source.js'
import { renderEntityDocument } from './backfill.js'
import { collectionsYmlPath } from './collections-config.js'

// Frontmatter keys that belong to the CCA framework / the developer's local
// authoring, not to externally-editable params. On a section write an existing
// reserved key is preserved and never overwritten by incoming params, so a
// projection doesn't churn fields it didn't author (the surgical-update bar).
export const DEFAULT_RESERVED_FRONTMATTER = new Set([
  'type',
  'preset',
  'input',
  'fetch',
  'data',
  'nest',
  'hidden',
])

// js-yaml dump options shared by every config write, so output is byte-stable.
const YAML_DUMP_OPTS = { lineWidth: -1, quotingType: "'", forceQuotes: false, noRefs: true }

/**
 * Write `text` to `filePath` only when it differs from what's on disk, using a
 * tmp-file + rename so a reader never sees a half-written file. Creates the
 * parent directory if absent. Idempotent — a no-op re-write reports 'unchanged'.
 *
 * @param {string} filePath
 * @param {string} text
 * @returns {'updated'|'unchanged'}
 */
export function writeIfChanged(filePath, text) {
  let current = null
  try {
    current = readFileSync(filePath, 'utf8')
  } catch {
    // new file / unreadable → treat as a change
  }
  if (text === current) return 'unchanged'
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, filePath)
  return 'updated'
}

/**
 * Find the `.md` file in `dirPath` whose name matches `stableId`, tolerating the
 * `@`-child prefix and numeric ordering prefix (`hero.md`, `@hero.md`, `1-hero.md`,
 * `@1-hero.md`). Returns the absolute path, or null when no file matches.
 *
 * @param {string} dirPath
 * @param {string} stableId
 * @returns {string|null}
 */
export function resolveSectionFile(dirPath, stableId) {
  if (!existsSync(dirPath)) return null
  const target = stableId.toLowerCase()

  for (const entry of readdirSync(dirPath)) {
    if (!entry.endsWith('.md')) continue
    const base = entry.slice(0, -3)

    if (base.toLowerCase() === target) return join(dirPath, entry)

    let name = base.startsWith('@') ? base.slice(1) : base
    if (name.toLowerCase() === target) return join(dirPath, entry)

    const numMatch = name.match(/^\d+-(.+)$/)
    if (numMatch && numMatch[1].toLowerCase() === target) return join(dirPath, entry)
  }
  return null
}

/**
 * Resolve the directory holding a page's (or layout area's) section files,
 * honoring `paths.pages` / `paths.layout` overrides and a page's `sourcePath`
 * (routes differ from directory names — route `/` maps to directory `home`).
 *
 * @param {string} siteRoot
 * @param {object} siteContent - `{ config?: { paths? }, pages?: [{ route, sourcePath }] }`
 * @param {string} pageRoute
 * @param {string|null} layoutArea
 * @returns {string} absolute directory path
 */
export function resolveSectionDir(siteRoot, siteContent, pageRoute, layoutArea) {
  const paths = siteContent?.config?.paths || {}

  if (layoutArea) {
    const layoutDir = paths.layout ? resolve(siteRoot, paths.layout) : join(siteRoot, 'layout')
    const areaDir = join(layoutDir, layoutArea)
    return existsSync(areaDir) ? areaDir : layoutDir
  }

  const pagesDir = paths.pages ? resolve(siteRoot, paths.pages) : join(siteRoot, 'pages')
  const page = siteContent?.pages?.find((p) => p.route === pageRoute)
  const sourcePath = page?.sourcePath
  if (sourcePath) return join(pagesDir, ...sourcePath.split('/').filter(Boolean))

  const routeParts = pageRoute === '/' ? [] : pageRoute.split('/').filter(Boolean)
  return join(pagesDir, ...routeParts)
}

/**
 * Resolve the absolute path of a section's `.md` file, or null when it doesn't
 * exist on disk yet (a new, externally-created section the caller must place).
 *
 * @param {string} siteRoot
 * @param {object} siteContent
 * @param {string} pageRoute
 * @param {string|null} layoutArea
 * @param {string} stableId
 * @returns {string|null}
 */
export function resolveSectionPath(siteRoot, siteContent, pageRoute, layoutArea, stableId) {
  return resolveSectionFile(resolveSectionDir(siteRoot, siteContent, pageRoute, layoutArea), stableId)
}

// Assemble a section file from frontmatter + a markdown body, matching
// @uniweb/content-writer's serializeSection layout exactly so files written here
// and there are byte-identical.
function assembleSection(frontmatter, body) {
  const fm = serializeFrontmatter(frontmatter)
  if (fm && body) return `${fm}\n\n${body}\n`
  if (fm) return `${fm}\n`
  if (body) return `${body}\n`
  return ''
}

/**
 * Write a section's `.md` file: merge incoming `params` into the existing
 * frontmatter (preserving reserved keys), serialize `content` (ProseMirror) to
 * the markdown body, and write idempotently. When the file is new there is no
 * existing frontmatter/body to preserve. When `content` is omitted, the existing
 * body is kept (a params-only update).
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {object} [opts.content] - ProseMirror document for the body
 * @param {object} [opts.params] - incoming frontmatter params to merge
 * @param {Set<string>} [opts.reserved] - keys preserved when already present
 * @returns {'updated'|'unchanged'}
 */
export function writeSectionFile({ filePath, content, params, reserved = DEFAULT_RESERVED_FRONTMATTER }) {
  let existing = ''
  try {
    existing = readFileSync(filePath, 'utf8')
  } catch {
    // new file
  }
  const { frontmatter, body: existingBody } = parseFrontmatter(existing)

  const nextFrontmatter = { ...frontmatter }
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      // A reserved key is preserved only when it already exists locally (the
      // developer owns it; an incoming edit must not clobber it). On a new file
      // there is nothing to protect, so the incoming value fills it — that's
      // how a newly-projected section gets its `type`/`nest`/etc.
      if (reserved.has(key) && key in frontmatter) continue
      if (value === null || value === undefined) delete nextFrontmatter[key]
      else nextFrontmatter[key] = value
    }
  }

  const body = content ? proseMirrorToMarkdown(content) : (existingBody || '').replace(/^\n+/, '').replace(/\s+$/, '')
  return writeIfChanged(filePath, assembleSection(nextFrontmatter, body))
}

// Shallow-merge `changes` into a YAML config file and write idempotently. A key
// whose value is null/undefined is deleted; an object value is shallow-merged one
// level deep (so partial `theme` / `build` updates don't drop sibling keys); any
// other value replaces. NOTE: this re-dumps the file, so author comments/order are
// not preserved — acceptable for machine-owned config, but comment-preserving
// merges for hand-authored config files are a quality bar to revisit.
function mergeYamlConfig(filePath, changes) {
  let existing = {}
  try {
    existing = yaml.load(readFileSync(filePath, 'utf8')) || {}
  } catch {
    // missing / invalid → start fresh
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined) {
      delete existing[key]
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      existing[key] = { ...(existing[key] || {}), ...value }
    } else {
      existing[key] = value
    }
  }
  return writeIfChanged(filePath, yaml.dump(existing, YAML_DUMP_OPTS))
}

/**
 * Merge `config` into `site.yml` (shallow). Preserves keys not present in the
 * update (foundation, base, paths, …).
 * @returns {'updated'|'unchanged'}
 */
export function writeSiteConfig(siteRoot, config) {
  return mergeYamlConfig(join(siteRoot, 'site.yml'), config)
}

/**
 * Write a YAML object to a file (full dump, idempotent) — for machine-owned
 * config the projector authors wholesale, e.g. a projected `page.yml`/`folder.yml`.
 * (Comment/unknown-key preservation is a later refinement; `site.yml`/
 * `collections.yml` use the merging writers instead.)
 * @returns {'updated'|'unchanged'}
 */
export function writeYamlFile(filePath, obj) {
  return writeIfChanged(filePath, yaml.dump(obj || {}, YAML_DUMP_OPTS))
}

/**
 * Write a YAML config file, replacing the projector-MANAGED keys with `projected`
 * while preserving any OTHER (author-authored) keys already on disk. A managed key
 * absent from `projected` is removed (the projector owns the managed set
 * wholesale); unknown keys keep their value and relative order. Idempotent.
 *
 * Same key-preserving (comment-dropping) bar as `writeSiteConfig` — for the
 * hand-authored `page.yml`/`folder.yml`, whose author-added keys must survive a
 * pull rather than being clobbered by a full re-dump.
 *
 * @param {string} filePath
 * @param {object} projected   - the managed keys + values to write (only keys the
 *                               record carries; absent managed keys are dropped)
 * @param {Set<string>|string[]} managedKeys - every key the projector owns
 * @returns {'updated'|'unchanged'}
 */
export function writeMergedYaml(filePath, projected, managedKeys) {
  let existing = {}
  try {
    existing = yaml.load(readFileSync(filePath, 'utf8')) || {}
  } catch {
    // missing / invalid → start fresh
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {}
  const out = { ...existing }
  for (const key of managedKeys) delete out[key]
  Object.assign(out, projected)
  return writeIfChanged(filePath, yaml.dump(out, YAML_DUMP_OPTS))
}

/**
 * Merge `config` into `collections/collections.yml` (shallow). Preserves sibling
 * keys the update doesn't touch — the folder `$uuid`, `sync`, `folders`, and any
 * collections not in the incoming set. A `collections:` object value is merged one
 * level deep (per-collection), so each declaration is replaced wholesale while
 * untouched collections stay. Same key-preserving (comment-dropping) bar as
 * `writeSiteConfig`.
 * @returns {'updated'|'unchanged'}
 */
export function writeCollectionsConfig(siteRoot, config) {
  return mergeYamlConfig(collectionsYmlPath(siteRoot), config)
}

/**
 * Merge `theme` into `theme.yml` (shallow, one level deep per top-level key).
 * @returns {'updated'|'unchanged'}
 */
export function writeThemeFile(siteRoot, theme) {
  return mergeYamlConfig(join(siteRoot, 'theme.yml'), theme)
}

/**
 * Render a finalized collection-record `document` to its source-file shape
 * (variant A, via renderEntityDocument) and write it idempotently. The record
 * half of the collections lane's write step.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {object} opts.document    - finalized `{ $uuid, $model, <brief>: {…} }`
 * @param {object} opts.declaration - the record's data-schema declaration
 * @param {'yaml'|'json'|'md'} opts.format
 * @param {string} [opts.sourceLocale]
 * @param {object} [opts.collector] - translation collector for localized scalar fields
 * @param {string} [opts.freeformRelPath] - free-form path for this record's content
 *        body (so a target-locale full-doc body is captured for locales/freeform/)
 * @returns {'updated'|'unchanged'}
 */
export function writeRecordFile({ filePath, document, declaration, format, sourceLocale = 'en', collector, freeformRelPath }) {
  const text = renderEntityDocument({ document, declaration, format, sourceLocale, collector, freeformRelPath })
  return writeIfChanged(filePath, text)
}
