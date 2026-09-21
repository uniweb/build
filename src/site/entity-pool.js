// A site's RECORDS on disk — every file in `records/`, and the model each one has.
//
// ⭐ PLACING A FILE IN `records/` IS WHAT MAKES IT A RECORD (ruled 2026-09-21
// [Diego]). The directory is the file side of the site's records folder: the
// backend's folder holds references to entities, and putting a ref in it is what
// makes one a record — putting a file in this directory is the same act. Nothing
// else is needed, and nothing lists it. (`records.yml` only organizes records into
// sub-folders; see `records-config.js`.) A file whose name starts with `_` or `.`
// is not read, so it is not a record.
//
// ⛔ A RECORD IS NOT "PUBLISHED" BY BEING HERE. `push` sends the site's records to a
// backend, and they are served once the SITE is published — publishing the site
// publishes its folder and what is in it. Nothing about a single record decides that.
//
// ⛔ THE PATH DECLARES THE MODEL, AND NOTHING ELSE. `collections/<name>/` used to
// mean three things at once — these files are entities, their schema is
// `@/<name>`, and they are grouped as `<name>` for placement. A schema folder here
// declares only the model; grouping is `records.yml`'s.
//
// ⇒ So nothing here reads a query or a folder. A site's records are a fact about
// the filesystem — plus `site.yml::paths.records`, which says where they live.
//
// ⭐ DEPTH NAMES THE SCOPE — the schema-ref grammar, spelled as directories:
//
//     records/person/ada.md         → @/person        (the foundation's own)
//     records/std/person/ada.md     → @std/person      (the shared standard set)
//     records/acme/project/x.md     → @acme/project    (an org's)
//
// matching `build/src/resolve-data-schema.js`, which is the only grammar there
// is: a bare directory name can mean `@/<name>` and nothing else.
//
// ⛔ BARE, NOT `records/@std/`. Measured: `@` is a reserved indicator in YAML
// 1.2, so a bare `@std/person/*.md` scalar throws in js-yaml — and the message is
// `bad indentation of a sequence entry`, which names neither the cause nor the
// fix. The `@` form would force quotes on every pattern in `records.yml` that
// names a scoped schema.
//
// ⛔ AND NO NESTING BELOW THE SCHEMA DIR, which is what makes the depth rule
// total: it is the FILE's depth that decides, so one path answers the question
// with nothing to classify and no ambiguous case to resolve. Organization is a
// `folder:` in `records.yml`, never a directory.
//
// ⛔ THE DIRECTORY WAS `entities/` UNTIL 2026-09-21, and `site.yml::paths.entities`
// the key that moved it. Both are refused by name rather than read (no alias —
// there is no population to carry): a leftover `entities/` beside `records/` would
// otherwise hold records nothing reads, silently.

import { readdir } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, extname, basename, resolve } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'

/** Where a site's records live, relative to its root, unless `site.yml::paths.records` moves them. */
export const RECORDS_DIR = 'records'

/** The directory's name until 2026-09-21. Read only to refuse it. */
const RETIRED_DIR = 'entities'

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readSitePaths(siteRoot) {
  const file = join(siteRoot, 'site.yml')
  if (!existsSync(file)) return {}
  try {
    const doc = yaml.load(readFileSync(file, 'utf8'), YAML_OPTIONS)
    return doc && typeof doc.paths === 'object' && doc.paths !== null ? doc.paths : {}
  } catch {
    // An unreadable site.yml is reported by whoever reads the site; this only
    // needs the one key, and the default is the right answer without it.
    return {}
  }
}

/**
 * Refuse the retired `entities/` directory when it is not the one the site reads.
 *
 * ⛔ A RENAMED DIRECTORY FAILS SILENTLY — its files are simply not read, and a site
 * with no records looks exactly like a site whose records moved. So its presence
 * stops the build, the push and every other reader, naming the new place.
 */
export function refuseRetiredRecordsDir(siteRoot, rel) {
  const retired = resolve(siteRoot, RETIRED_DIR)
  if (resolve(siteRoot, rel) === retired) return
  if (!isDirectory(retired)) return
  throw new Error(
    `[uniweb] ${RETIRED_DIR}/ is not read — a site's records live in \`${rel}/\` now. ` +
      `Rename the directory (\`git mv ${RETIRED_DIR} ${rel}\`) and every file in it is a record, ` +
      `as before; records.yml no longer lists them.`
  )
}

/**
 * Where a site's records live — `site.yml::paths.records`, else `records/`.
 *
 * ⭐ THE ONE RESOLVER, and every lane asks it: the build, the push, the pull and
 * the CLI. ⛔ Until 2026-09-21 only the build honoured the key — then called
 * `paths.entities` — while push read the default, so a site that moved its records
 * built fine and then failed to push, with an error naming a directory it did not
 * use (measured).
 *
 * @param {string} siteRoot
 * @param {object} [paths] - `site.yml::paths`, when the caller has already read it;
 *   otherwise `site.yml` is read here.
 * @returns {{ rel: string, abs: string }} `rel` as written (for messages), `abs`
 *   resolved against the site root — an absolute `paths.records` is honoured.
 */
export function resolveRecordsDir(siteRoot, paths) {
  const p = paths === undefined ? readSitePaths(siteRoot) : paths || {}
  if (p.entities !== undefined) {
    throw new Error(
      `[uniweb] site.yml: \`paths.entities\` is now \`paths.records\` — the directory a site's ` +
        `records live in. Rename the key.`
    )
  }
  const rel = typeof p.records === 'string' && p.records.trim() ? p.records.trim().replace(/\/+$/, '') : RECORDS_DIR
  refuseRetiredRecordsDir(siteRoot, rel)
  return { rel, abs: resolve(siteRoot, rel) }
}

/** Source extensions a record file may have. Mirrors the sync-lane reader. */
export const ENTITY_EXTENSIONS = new Set(['.md', '.yml', '.yaml', '.json', '.bib'])

const isHidden = (name) => name.startsWith('_') || name.startsWith('.')

/**
 * The schema ref a pool path names.
 *
 * @param {string[]} dirs - the directory segments below `records/`
 * @returns {string|null} the ref, or null when the depth names no schema
 */
export function schemaForPoolDirs(dirs) {
  if (dirs.length === 1) return `@/${dirs[0]}`
  if (dirs.length === 2) return `@${dirs[0]}/${dirs[1]}`
  return null
}

/**
 * Where a schema's records live — the inverse of `schemaForPoolDirs`.
 *
 * ⛔ ONE IMPLEMENTATION AND ITS INVERSE, IN ONE PLACE, for the reason this file
 * exists at all: the reader derives a model from a path and the pull side derives
 * a path from a model, and if those two ever disagree a pulled record lands
 * somewhere the next build reads as a different schema. Same rule as
 * `deferredFromSchema` — a deriver and its recognizer must not be two copies.
 *
 * @param {string} schema - a ref: `@/name` or `@org/name`
 * @returns {string[]|null} the directory segments below `records/`, or null for
 *   a ref this layout cannot express
 */
export function poolDirsForSchema(schema) {
  if (typeof schema !== 'string') return null
  const self = /^@\/([^/]+)$/.exec(schema)
  if (self) return [self[1]]
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(schema)
  if (scoped) return [scoped[1], scoped[2]]
  return null
}

/**
 * Both readings of a 2-segment pool path, for an error that has to name them.
 *
 * ⚠️ A reader who mistakes `records/person/2024/ada.md` for "the `person`
 * schema, organised by year" needs to be told what the build actually did with
 * it, not merely that something did not resolve. The wrong reading is the
 * plausible one, so the message carries both.
 */
export function poolPathReadings(dirs) {
  return {
    read: schemaForPoolDirs(dirs),
    alternative: dirs.length === 2 ? `@/${dirs[0]}` : null,
  }
}

/**
 * Read a site's records.
 *
 * Returns them in a stable, path-sorted order — the wire's package digest
 * depends on it — each carrying the model its path declares.
 *
 * ⚠️ NOTHING HERE RESOLVES A SCHEMA. Whether `@std/person` is a schema this site
 * can actually see is a question for whoever holds the foundation's built schema
 * map, and only that caller can raise the error §4 of the model asks for. This
 * reports the directory's SHAPE — a file with no schema above it, a file nested
 * too deep — because those are answerable from the filesystem alone.
 *
 * @param {string} siteRoot
 * @param {object} [opts]
 * @param {string} [opts.dir] - the records directory, site-root-relative or
 *   absolute, when the caller already resolved it; otherwise `resolveRecordsDir`
 *   reads `site.yml::paths.records`.
 * @returns {Promise<{
 *   entities: Array<{ id, schema, slug, dirs, relPath, absPath, ext }>,
 *   errors: string[],
 *   exists: boolean,
 *   dir: string,
 * }>}
 *   `id` is the record's path under `records/` without its extension — unique
 *   by construction, stable across pushes, and derivable identically on both
 *   sides without either lane holding the other's ids. `exists` is whether the
 *   directory is there at all, which is not the same as holding nothing: a push
 *   leaves the backend's folder alone for a site with no records directory.
 */
export async function readEntityPool(siteRoot, opts = {}) {
  let rel
  if (opts.dir) {
    rel = String(opts.dir).replace(/\/+$/, '')
    refuseRetiredRecordsDir(siteRoot, rel)
  } else {
    rel = resolveRecordsDir(siteRoot).rel
  }
  // ⛔ `resolve`, not `join`: an absolute `paths.records` is supported, and
  // `join(siteRoot, '/abs')` is a path under the site root that does not exist.
  const base = resolve(siteRoot, rel)
  if (!isDirectory(base)) return { entities: [], errors: [], exists: false, dir: rel }

  const entities = []
  const errors = []

  const walk = async (dir, dirs) => {
    let listing
    try {
      listing = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (isHidden(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (dirs.length >= 2) {
          // Deeper than a schema dir. Say what the path was read AS, because the
          // author's intent (organising records inside a schema) is the reading
          // this layout deliberately does not have.
          const { read } = poolPathReadings(dirs)
          errors.push(
            `${rel}/${[...dirs, e.name].join('/')}/ is nested below a schema folder. ` +
              `\`${rel}/\` declares a model and nothing else — \`${[...dirs].join('/')}\` ` +
              `already names ${read}, so there is no meaning left for a folder inside it. ` +
              `Organise records in records.yml (a \`folder:\` entry), not on disk.`
          )
          continue
        }
        await walk(full, [...dirs, e.name])
        continue
      }
      if (!e.isFile()) continue
      const ext = extname(e.name).toLowerCase()
      if (!ENTITY_EXTENSIONS.has(ext)) continue
      if (dirs.length === 0) {
        errors.push(
          `${rel}/${e.name} sits directly in \`${rel}/\`, which names no model. ` +
            `Move it under a schema folder — \`${rel}/<name>/\` for \`@/<name>\`, ` +
            `or \`${rel}/<org>/<name>/\` for \`@<org>/<name>\`.`
        )
        continue
      }
      // ⛔ THE SLUG IS THE FILENAME STEM, WHOLE — nothing is stripped from it.
      // A leading number orders a set (`01-`, `02-`) at least as often as it is a
      // DATE (`2026-03-…`), and the two are indistinguishable by shape, so
      // consuming one into the record's name mangles the other. A number is read
      // to SORT by (`compareByNumericPrefix`) and never to rename.
      const slug = basename(e.name, ext)
      entities.push({
        id: [...dirs, slug].join('/'),
        schema: schemaForPoolDirs(dirs),
        slug,
        file: e.name,
        dirs: [...dirs],
        relPath: [rel, ...dirs, e.name].join('/'),
        poolPath: [...dirs, e.name].join('/'),
        absPath: full,
        ext,
      })
    }
  }

  await walk(base, [])
  return { entities, errors, exists: true, dir: rel }
}

/**
 * The pool grouped by the schema each path declares.
 *
 * ⭐ This is what a query resolves against: it names a `schema:` and the pool
 * follows, so there is no disk path for it to name. (`source:` survives for
 * REMOTE sources, where the address is genuinely external.)
 *
 * @returns {Map<string, Array>} schema ref → entities, in pool order
 */
export function groupPoolBySchema(entities) {
  const bySchema = new Map()
  for (const e of entities || []) {
    if (!e?.schema) continue
    if (!bySchema.has(e.schema)) bySchema.set(e.schema, [])
    bySchema.get(e.schema).push(e)
  }
  return bySchema
}
