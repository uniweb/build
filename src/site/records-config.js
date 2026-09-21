// `records.yml` — how the site's records folder is ORGANIZED. Optional.
//
// ⭐ IT DOES NOT SAY WHAT IS IN THE FOLDER (ruled 2026-09-21 [Diego]). Every file in
// `records/` is a record — placing it there is what makes one (`entity-pool.js`).
// This file only sorts records into sub-folders, so a site whose records are one
// flat set has no `records.yml` at all, which is the common case.
//
// ⛔ UNTIL 2026-09-21 THIS FILE WAS THE MEMBERSHIP LIST: a bare string at the top
// level listed an entity and made it a record, an unlisted one was left out, and
// the file's absence or emptiness decided what a push did. All of that moved to
// the directory. A top-level path is refused rather than read — it would claim to
// select records while selecting nothing.
//
// ⛔ AND STRUCTURE IS QUERY SCOPE, NOT NAVIGATION. A `folder:` is an addressable
// dimension a query slices on — `scope: archive` — never a menu, a listing or a URL
// tree. The question is not "does this site want sub-pages?" but "will a query ever
// ask for a SLICE rather than the whole set?" Most will not, which is why flat is
// the norm rather than a simplification.
//
// ⭐ THE SHAPE IS A LIST OF FOLDERS, each holding records by path — one file, or a
// pattern matching many — and further folders:
//
//     - folder: archive
//       label: Publication Archive
//       records:
//         - publication/2025-*.md
//
// Every record no folder names sits at the top of the site's folder.
//
// ⛔ NO QUERIES IN HERE. A computed subset is a named query, in `queries.yml`.
// Organizing places records; queries compute. Two constructs, two jobs.
//
// Model: record · folder · query.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { compareByNumericPrefix } from '../utils/numeric-prefix.js'
import { RECORDS_DIR } from './entity-pool.js'

export const RECORDS_YML_RELPATH = 'records.yml'

/** Path to the records.yml file (whether or not it exists yet). */
export function recordsYmlPath(siteRoot) {
  return join(siteRoot, RECORDS_YML_RELPATH)
}

/**
 * Match one record path against a `records.yml` pattern.
 *
 * ⛔ `*` DOES NOT CROSS A `/`, which is what a reader expects of a file pattern
 * and is NOT what `@uniweb/core`'s `globMatch` does. That one backs the `like`
 * PREDICATE, where a value is one opaque string and a cross-segment `*` is
 * correct. Same syntax, different question — so this is a deliberate second
 * implementation, not a copy that drifted. Do not "converge" them.
 */
export function matchEntityPattern(pattern, relPath) {
  const re =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
    + '$'
  return new RegExp(re).test(relPath)
}

/** Does this string name one exact file rather than a set? */
const isPattern = (s) => /[*?]/.test(s)

/**
 * The slug a record is addressed by — its filename stem, whole.
 *
 * ⛔ NOTHING IS STRIPPED. A leading number is a DATE (`2026-03-…`) at least as
 * often as it is an order (`01-`), and nothing in the filename distinguishes
 * them, so consuming one into the name mangles the other. A number is read to
 * SORT by and never to rename. *(An earlier draft of the model stripped a leading
 * `01-`; implementing it against the model's own example pool is what surfaced
 * the collision, and the idea was withdrawn.)*
 */
export function slugForEntity(entity) {
  return entity.slug
}

/**
 * Read `records.yml` — the folder's organization.
 *
 * ⭐ MISSING AND EMPTY MEAN THE SAME: no sub-folders, every record at the top.
 * ⛔ Until 2026-09-21 they differed — missing left a backend's folder alone, empty
 * removed what was there — because this file decided what was in the folder. The
 * `records/` directory decides that now, so no state of this file removes a record.
 *
 * ⛔ A MALFORMED FILE IS STILL AN ERROR: what it meant to organize cannot be guessed.
 *
 * @returns {Promise<{ exists: boolean, entries: Array, error: string|null }>}
 */
export async function readRecordsConfig(siteRoot) {
  const file = join(siteRoot, RECORDS_YML_RELPATH)
  if (!existsSync(file)) return { exists: false, entries: [], error: null }

  let doc
  try {
    doc = yaml.load(await readFile(file, 'utf8'), YAML_OPTIONS)
  } catch (err) {
    return { exists: true, entries: [], error: `${RECORDS_YML_RELPATH}: ${err.message}` }
  }

  if (doc === null || doc === undefined) return { exists: true, entries: [], error: null }
  if (!Array.isArray(doc)) {
    return {
      exists: true,
      entries: [],
      error:
        `${RECORDS_YML_RELPATH} must be a LIST of folders, not ${typeof doc === 'object' ? 'a mapping' : 'a single value'}. ` +
        `For example:\n  - folder: archive\n    records:\n      - publication/2025-*.md`,
    }
  }
  return { exists: true, entries: doc, error: null }
}

/**
 * Place the site's records in its folder: the sub-folders `records.yml` declares,
 * and the top of the folder for every record no sub-folder names.
 *
 * Every rule here is a guard, and each one exists because its failure was
 * SILENT. `entries: [artcles]` used to produce a real, reachable, empty path
 * with no warning at all.
 *
 * ⛔ ONE PLACEMENT PER RECORD. Two entries matching one file is a hard error, not
 * a second placement. The wire could carry many-to-many — `folder.js` nests, and
 * a placement is banked by the record it references — but a record's `path` is one string:
 * `@uniweb/core`'s `withinScope` matches nothing that is not a string, so a record
 * with two paths would fall outside every `scope:`, silently. The records service
 * evaluates `scope` natively, so widening it is a cross-lane change to agree first,
 * not to infer. Until then the file lane is the floor: one folder.
 *
 * @param {Array} entries - the parsed `records.yml` list
 * @param {Array} pool - records from `readEntityPool`
 * @param {object} [opts]
 * @param {string} [opts.dir] - the records directory as written, for messages
 * @returns {{ nodes: Array, placements: Map, errors: string[], warnings: string[] }}
 *   `nodes` is the folder tree — the declared sub-folders in file order, then every
 *   record no sub-folder names; `placements` maps EVERY record's id to its
 *   `{ entity, path, slug }`, `path` being `''` at the top of the folder.
 */
export function resolveFolder(entries, pool, { dir = RECORDS_DIR } = {}) {
  const errors = []
  const warnings = []
  const placements = new Map()
  // Which entry claimed a file, so the second one can name the first.
  const claimedBy = new Map()

  const byRelPath = new Map()
  for (const e of pool || []) {
    // ⚠️ KEYED BY THE FILE AS IT EXISTS, prefix and all — an author writing
    // `post/01-lab-opens.md` is naming a file they can see, not the slug it
    // produces. `poolPath` is that path, relative to `records/`.
    byRelPath.set(e.poolPath, e)
  }

  const place = (entity, pathSegs, where) => {
    const key = entity.id
    const prior = claimedBy.get(key)
    if (prior) {
      errors.push(
        `${RECORDS_YML_RELPATH}: "${entity.relPath}" is placed twice — by ${prior} and by ${where}. ` +
          `A record sits in one folder; a computed subset is a named query, not a second placement.`
      )
      return null
    }
    claimedBy.set(key, where)
    const slug = slugForEntity(entity)
    const path = pathSegs.join('/')
    placements.set(key, { entity, path, slug })
    return { kind: 'ref', name: slug, $entityId: key }
  }

  const resolveEntry = (entry, pathSegs, index, trail) => {
    const where = `entry ${trail}[${index}]`

    if (typeof entry === 'string') {
      const pattern = entry.trim()
      // ⛔ A PATH AT THE TOP LEVEL SELECTED RECORDS until 2026-09-21 — it was how a
      // file became one. Every file in the directory is a record now, so the line
      // would claim to choose while choosing nothing: refused, with the reason.
      if (pathSegs.length === 0) {
        errors.push(
          `${RECORDS_YML_RELPATH}: ${where} ("${pattern}") lists records at the top level. Every file in ` +
            `${dir}/ is a record already — ${RECORDS_YML_RELPATH} only sorts records into folders. ` +
            `Remove the entry, or put it under a \`folder:\`.`
        )
        return []
      }
      if (!pattern) {
        errors.push(`${RECORDS_YML_RELPATH}: ${where} is an empty string.`)
        return []
      }
      if (!isPattern(pattern)) {
        const hit = byRelPath.get(pattern)
        if (!hit) {
          errors.push(
            `${RECORDS_YML_RELPATH}: ${where} names "${pattern}", which is not in ${dir}/. ` +
              `A path is relative to ${dir}/, extension included.`
          )
          return []
        }
        const leaf = place(hit, pathSegs, where)
        return leaf ? [leaf] : []
      }
      // ⛔ A PATTERN MATCHING NOTHING IS AN ERROR. `artcle/*.md` is the old
      // empty-branch defect respelled, and it produced a real, reachable, empty
      // path with no warning.
      const matches = [...byRelPath.entries()]
        .filter(([rel]) => matchEntityPattern(pattern, rel))
        .map(([, e]) => e)
      if (matches.length === 0) {
        errors.push(
          `${RECORDS_YML_RELPATH}: ${where} pattern "${pattern}" matches no record in ${dir}/. ` +
            `Check the schema folder name and the extension.`
        )
        return []
      }
      // Matches sort alphanumerically by filename, numeric-aware — so `1-`, `2-`,
      // `10-` order as written rather than as strings, and `2025-…` precedes
      // `2026-…`. Ordering only: the number never leaves the name.
      matches.sort((a, b) => compareByNumericPrefix(a.slug, b.slug))
      return matches.map((e) => place(e, pathSegs, where)).filter(Boolean)
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(
        `${RECORDS_YML_RELPATH}: ${where} is neither ${pathSegs.length ? 'a path nor ' : ''}a \`folder:\` entry.`
      )
      return []
    }

    if (entry.folder !== undefined) {
      // ⚠️ COERCED, because YAML types a bare `2024` as a NUMBER — and a folder
      // named for a year is the single most likely one anybody writes. Both the
      // segment and the label reach the wire as strings; passing a number through
      // would surface as a type error on the far side, far from the file that
      // caused it. `0` is a legal folder name, so this tests for absence rather
      // than falsiness.
      const raw = entry.folder
      const segment = raw === null || raw === undefined ? '' : String(raw).trim()
      if (!segment) {
        errors.push(`${RECORDS_YML_RELPATH}: ${where} declares a folder with no name.`)
        return []
      }
      // ⭐ A folder's `name` is the segment a query's `scope:` names; `label` is its
      // display text. The store renamed the pair on 2026-09-04 — `path_segment` →
      // `name`, and the old `name` (display) → `label`. ⛔ Not a URL segment: a folder
      // is the curator's organization and maps to no route unless a query binds
      // `scope: :dir` [Diego]. *("the URL segment, sibling-unique" stood here until
      // 2026-09-21.)*
      const branch = { kind: 'branch', name: segment }
      if (entry.label !== undefined && entry.label !== null) branch.label = String(entry.label)
      const kids = Array.isArray(entry.records) ? entry.records : []
      if (kids.length === 0) {
        warnings.push(
          `${RECORDS_YML_RELPATH}: folder "${segment}" (${where}) holds no records. ` +
            `A folder exists to be QUERIED — if no query needs the slice, do not make it.`
        )
      }
      branch.$children = kids.flatMap((child, i) =>
        resolveEntry(child, [...pathSegs, segment], i, `${trail}[${index}].records`)
      )
      return [branch]
    }

    // ⛔ REJECT LOUDLY RATHER THAN IGNORE. The union's shape is settled and these
    // are part of it, but framework emits only `ref` and `branch` today. Silently
    // dropping an entry an author wrote is the failure mode this whole file
    // exists to prevent.
    if (entry.url !== undefined || entry.asset !== undefined) {
      const kind = entry.url !== undefined ? 'url' : 'asset'
      errors.push(
        `${RECORDS_YML_RELPATH}: ${where} declares \`${kind}:\`, which the folder producer ` +
          `does not emit yet. A folder holds urls and assets by design, but nothing would ` +
          `be sent for this entry — so it is refused rather than dropped.`
      )
      return []
    }

    errors.push(
      `${RECORDS_YML_RELPATH}: ${where} has no recognized kind. ` +
        (pathSegs.length
          ? `Inside a folder, a path names records; anything else says \`folder:\`.`
          : `An entry is a \`folder:\` — its \`records:\` are paths under ${dir}/.`)
    )
    return []
  }

  const branches = (entries || []).flatMap((entry, i) => resolveEntry(entry, [], i, ''))

  // ⭐ EVERY RECORD NO FOLDER NAMES SITS AT THE TOP — placement in the directory is
  // what made it a record, so there is nothing for it to be left out of. In the
  // directory's order, numeric-aware within a schema folder, the same order a
  // pattern's matches take.
  const unplaced = (pool || []).filter((e) => !placements.has(e.id))
  const dirKey = (e) => (e.dirs || []).join('/')
  unplaced.sort((a, b) => {
    const da = dirKey(a)
    const db = dirKey(b)
    if (da !== db) return da < db ? -1 : 1
    return compareByNumericPrefix(a.slug, b.slug)
  })
  const top = unplaced.map((e) => place(e, [], 'the directory')).filter(Boolean)

  return { nodes: [...branches, ...top], placements, errors, warnings }
}
