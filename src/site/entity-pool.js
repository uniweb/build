// A site's ENTITY POOL — every stored thing on disk, and the model each one has.
//
// ⛔ THE PATH DECLARES THE MODEL, AND NOTHING ELSE. That is the whole point of
// this directory, and it is the de-conflation the records model is built on:
// `collections/<name>/` used to mean three things at once — these files are
// entities, their schema is `@/<name>`, and they are grouped as `<name>` for
// placement. `entities/{schema}/` declares only the first two. Grouping moved to
// `records.yml`, which is what makes an entity a RECORD.
//
// ⇒ So nothing here reads a query, a folder, or any config. A pool is a fact
// about the filesystem.
//
// ⭐ DEPTH NAMES THE SCOPE — the schema-ref grammar, spelled as directories:
//
//     entities/person/ada.md         → @/person        (the foundation's own)
//     entities/std/person/ada.md     → @std/person      (the shared standard set)
//     entities/acme/project/x.md     → @acme/project    (an org's)
//
// matching `build/src/resolve-data-schema.js`, which is the only grammar there
// is: a bare directory name can mean `@/<name>` and nothing else.
//
// ⛔ BARE, NOT `entities/@std/`. Measured: `@` is a reserved indicator in YAML
// 1.2, so a bare `@std/person/*.md` scalar throws in js-yaml — and the message is
// `bad indentation of a sequence entry`, which names neither the cause nor the
// fix. The `@` form would force quotes on the most common line in `records.yml`
// and put two spellings in one list.
//
// ⛔ AND NO NESTING BELOW THE SCHEMA DIR, which is what makes the depth rule
// total: it is the FILE's depth that decides, so one path answers the question
// with nothing to classify and no ambiguous case to resolve.
//
// ⭐ That costs nothing — it CLOSES a divergence that was live and silent.
// `uwx/collection-source.js::reportNestedRecords` warns today that records below
// a collection's top level "build and render locally but are absent from the
// synced set": the delivery lane recursed and the sync lane was one level deep.
// `records.yml` replaces on-disk nesting outright, so the two lanes stop
// disagreeing rather than being taught to agree.

import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, basename } from 'node:path'

/** Where a site's entities live, relative to its root. */
export const ENTITIES_DIR = 'entities'

/** Source extensions an entity file may have. Mirrors the sync-lane reader. */
export const ENTITY_EXTENSIONS = new Set(['.md', '.yml', '.yaml', '.json', '.bib'])

const isHidden = (name) => name.startsWith('_') || name.startsWith('.')

/**
 * The schema ref a pool path names.
 *
 * @param {string[]} dirs - the directory segments below `entities/`
 * @returns {string|null} the ref, or null when the depth names no schema
 */
export function schemaForPoolDirs(dirs) {
  if (dirs.length === 1) return `@/${dirs[0]}`
  if (dirs.length === 2) return `@${dirs[0]}/${dirs[1]}`
  return null
}

/**
 * Where a schema's entities live — the inverse of `schemaForPoolDirs`.
 *
 * ⛔ ONE IMPLEMENTATION AND ITS INVERSE, IN ONE PLACE, for the reason this file
 * exists at all: the reader derives a model from a path and the pull side derives
 * a path from a model, and if those two ever disagree a pulled record lands
 * somewhere the next build reads as a different schema. Same rule as
 * `deferredFromSchema` — a deriver and its recognizer must not be two copies.
 *
 * @param {string} schema - a ref: `@/name` or `@org/name`
 * @returns {string[]|null} the directory segments below `entities/`, or null for
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
 * ⚠️ A reader who mistakes `entities/person/2024/ada.md` for "the `person`
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
 * Read a site's entity pool.
 *
 * Returns entities in a stable, path-sorted order — the wire's package digest
 * depends on it — each carrying the model its path declares.
 *
 * ⚠️ NOTHING HERE RESOLVES A SCHEMA. Whether `@std/person` is a schema this site
 * can actually see is a question for whoever holds the foundation's built schema
 * map, and only that caller can raise the error §4 of the model asks for. This
 * reports the pool's SHAPE — a file with no schema above it, a file nested too
 * deep — because those are answerable from the filesystem alone.
 *
 * @param {string} siteRoot
 * @param {object} [opts]
 * @param {string} [opts.dir] - override the pool directory (site-root-relative)
 * @returns {Promise<{
 *   entities: Array<{ id, schema, slug, dirs, relPath, absPath, ext }>,
 *   errors: string[],
 *   exists: boolean,
 * }>}
 *   `id` is the entity's path under `entities/` without its extension — unique
 *   by construction, stable across pushes, and derivable identically on both
 *   sides without either lane holding the other's ids.
 */
export async function readEntityPool(siteRoot, opts = {}) {
  const rel = opts.dir || ENTITIES_DIR
  const base = join(siteRoot, rel)
  if (!existsSync(base)) return { entities: [], errors: [], exists: false }

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
  return { entities, errors, exists: true }
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
