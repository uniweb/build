// Resolve a site's collection configuration from the (optional, local-first)
// `collections/collections.yml`, layered over the legacy `site.yml::collections`
// and the zero-config subfolder-name convention.
//
// `collections.yml` is the co-located home for FILE-BASED collection declarations
// (it sits with the data it describes). It is useful with NO backend at all — it
// maps each subfolder to a data schema, declares query/display config, and can lay
// out a VIRTUAL folder organization decoupled from the on-disk layout. When a
// project syncs, it additionally carries the `@uniweb/folder` entity `$uuid`.
//
// Precedence (per-collection, per-key): collections.yml  >  site.yml::collections.
// `site.yml::collections` stays valid for remote `url:` sources and back-compat.
// When neither declares a schema, the subfolder-name convention fills it
// (`articles` → `@/article`). Absent the file entirely, behavior is unchanged.

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readYamlFile } from '../site/content-collector.js'

export const COLLECTIONS_YML_RELPATH = 'collections/collections.yml'

// Naive English singularization — enough for the schema-name default (an explicit
// `schema:` always overrides). `categories` → `category`, `boxes` → `box`,
// `articles` → `article`, `team` → `team` (unchanged).
function singularize(name) {
  if (/[^aeiou]ies$/i.test(name)) return name.slice(0, -3) + 'y'
  if (/(ses|xes|zes|ches|shes)$/i.test(name)) return name.slice(0, -2)
  if (/[^s]s$/i.test(name)) return name.slice(0, -1)
  return name
}

// Default data-schema ref for a collection with no explicit `schema:` — the
// self-scope (`@/`) singular of its name. `@/` resolves to the local foundation's
// `schemas/` (named-data-schemas), so this stays backend-independent. Exported so
// the inverse (projection) can drop a `schema:` that merely restates this default,
// keeping a projected collections.yml as terse as the author would have left it.
export function defaultSchema(name) {
  return `@/${singularize(name)}`
}

// Normalize one site.yml::collections entry (string shorthand or object) to the
// internal decl shape. Paths here are already site-root-relative (legacy contract).
function normalizeSiteDecl(name, decl) {
  if (typeof decl === 'string') return { name, path: decl }
  const d = decl && typeof decl === 'object' ? decl : {}
  return { name, ...d }
}

// Normalize one collections.yml::collections entry. Its `path:` is relative to the
// collections/ directory (default = the collection name); we lift it to a
// site-root-relative path so downstream readers resolve it uniformly.
function normalizeYmlDecl(name, decl) {
  const d = decl && typeof decl === 'object' ? decl : {}
  const rel = typeof d.path === 'string' ? d.path : name
  return { name, ...d, path: `collections/${rel}` }
}

/**
 * Resolve the merged collection configuration for a site.
 *
 * @param {string} siteRoot - directory containing site.yml + collections/
 * @param {object} [opts]
 * @param {object} [opts.siteYml] - an already-read site.yml (avoids a re-read)
 * @returns {Promise<{
 *   folderUuid: string|undefined,   // collections.yml `$uuid` (the @uniweb/folder id)
 *   folderSync: boolean,            // collections.yml `sync` (whole-folder opt-out)
 *   hasCollectionsYml: boolean,
 *   declarations: object,           // { name: decl }  — merged, schema-defaulted
 *   folders: Array|null,            // collections.yml `folders` (virtual org) or null
 * }>}
 */
export async function resolveCollectionsConfig(siteRoot, opts = {}) {
  const siteYml = opts.siteYml || (await readYamlFile(join(siteRoot, 'site.yml')))
  const ymlPath = join(siteRoot, COLLECTIONS_YML_RELPATH)
  const hasCollectionsYml = existsSync(ymlPath)
  const colYml = hasCollectionsYml ? await readYamlFile(ymlPath) : {}

  const declarations = {}

  // Legacy site.yml::collections first (lower precedence).
  const siteCols = siteYml?.collections
  if (siteCols && typeof siteCols === 'object' && !Array.isArray(siteCols)) {
    for (const [name, decl] of Object.entries(siteCols)) {
      declarations[name] = normalizeSiteDecl(name, decl)
    }
  }

  // collections.yml::collections overlay (higher precedence; per-key merge).
  const ymlCols = colYml?.collections
  if (ymlCols && typeof ymlCols === 'object' && !Array.isArray(ymlCols)) {
    for (const [name, decl] of Object.entries(ymlCols)) {
      const incoming = normalizeYmlDecl(name, decl)
      declarations[name] = { ...(declarations[name] || {}), ...incoming, name }
    }
  }

  // Schema default (subfolder-name convention) + `model:`→`schema:` synonym.
  // `schemaExplicit` records whether the author asked for this schema: an explicit
  // schema that fails to resolve is a hard error; a convention-defaulted one that
  // fails to resolve soft-skips (so a delivery-only collection never breaks sync).
  for (const decl of Object.values(declarations)) {
    if (decl.schema) {
      decl.schemaExplicit = true
    } else if (decl.model) {
      decl.schema = decl.model // migration synonym
      decl.schemaExplicit = true
    } else if (decl.path || !decl.url) {
      decl.schema = defaultSchema(decl.name) // subfolder-name convention
      decl.schemaExplicit = false
    }
  }

  const folderSync = colYml?.sync !== false
  return {
    folderUuid: typeof colYml?.$uuid === 'string' ? colYml.$uuid : undefined,
    folderSync,
    hasCollectionsYml,
    declarations,
    folders: Array.isArray(colYml?.folders) ? colYml.folders : null,
  }
}

/** Path to the collections.yml file (whether or not it exists yet). */
export function collectionsYmlPath(siteRoot) {
  return join(siteRoot, COLLECTIONS_YML_RELPATH)
}
