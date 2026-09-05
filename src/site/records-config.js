// `records.yml` — the site's FOLDER: what is in it, and where.
//
// ⭐ LISTING AN ENTITY HERE IS WHAT MAKES IT A RECORD. An entity in `entities/`
// exists; a record is a leaf entry in the site's folder. The backend's own gauge:
// "An entity in no folder is not a record either: it exists, but cannot be
// publicly fetched; placing a ref to it in a published folder is what makes one."
// ⇒ An unreferenced entity is a draft, for free, with no flag to set.
//
// ⛔ IT IS A DATABASE, NOT A PAGE SYSTEM. Records are data. They usually have no
// structure at all — a flat pool, and THE COMMON CASE IS THREE LINES:
//
//     - person/*.md
//     - publication/*.md
//     - project/*.md
//
// ⛔ AND STRUCTURE IS QUERY SCOPE, NOT NAVIGATION. A `folder:` is an addressable
// dimension a query slices on — `where: { path: { under: 'archive' } }` — never a
// menu, a listing or a URL tree. The question is not "does this site want
// sub-pages?" but "will a query ever ask for a SLICE rather than the whole pool?"
// Most will not, which is why flat is the norm rather than a simplification.
//
// ⭐ THE SHAPE IS A LIST, and an entity gets no ceremony: a bare string IS an
// entity path, one file or a pattern matching many. Only the exceptions announce
// themselves — `url:`, `asset:`, `folder:`. (An earlier design keyed a map by
// entry name; it charged every entry a key, a kind and often a label to buy
// navigation ergonomics most sites never use. Measured on a realistic file: 7 of
// 11 entries are just a path.)
//
// ⛔ NO QUERIES IN HERE. A computed subset is a named query, in `queries.yml`.
// Curation enumerates; queries compute. Two constructs, two jobs.
//
// ⭐ AND IT IS THE SYNC CONTROL. What syncs is exactly what this file references —
// no flag, no inference. `missing` and `empty` differ deliberately:
//
//     missing  → inert. Do not sync; leave the server's folder untouched.
//     empty    → destructive. Sync an empty folder, removing what is there.
//
// The safe state is the ABSENCE of a file and the destructive act requires
// affirmatively creating one, so a live folder cannot be wiped by deleting
// something. ⛔ Do not "simplify" these into one behaviour — it would delete a
// capability. The placeholder hazard (someone creates an empty file meaning to
// fill it in) is guarded at the CLI with a count and a confirmation; the format
// stays honest and the CLI does the asking.
//
// Model: entity · record · query · folder.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { compareByNumericPrefix } from '../utils/numeric-prefix.js'

export const RECORDS_YML_RELPATH = 'records.yml'

/** Path to the records.yml file (whether or not it exists yet). */
export function recordsYmlPath(siteRoot) {
  return join(siteRoot, RECORDS_YML_RELPATH)
}

/** What `records.yml` says about syncing, before any entry is resolved. */
export const FOLDER_MISSING = 'missing'
export const FOLDER_EMPTY = 'empty'
export const FOLDER_DECLARED = 'declared'

/**
 * Match one entity path against a `records.yml` pattern.
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
 * Read `records.yml`.
 *
 * ⛔ THE THREE STATES ARE NOT TWO. `missing` and `empty` mean different things
 * and the difference is load-bearing (see the header), so this reports which it
 * saw rather than collapsing them into "no entries".
 *
 * @returns {Promise<{ state: string, entries: Array, error: string|null }>}
 */
export async function readRecordsConfig(siteRoot) {
  const file = join(siteRoot, RECORDS_YML_RELPATH)
  if (!existsSync(file)) return { state: FOLDER_MISSING, entries: [], error: null }

  let doc
  try {
    doc = yaml.load(await readFile(file, 'utf8'))
  } catch (err) {
    return { state: FOLDER_MISSING, entries: [], error: `${RECORDS_YML_RELPATH}: ${err.message}` }
  }

  if (doc === null || doc === undefined || (Array.isArray(doc) && doc.length === 0)) {
    return { state: FOLDER_EMPTY, entries: [], error: null }
  }
  if (!Array.isArray(doc)) {
    return {
      state: FOLDER_MISSING,
      entries: [],
      error:
        `${RECORDS_YML_RELPATH} must be a LIST of what is in the folder, not a mapping. ` +
        `The common case is three lines:\n  - person/*.md\n  - publication/*.md`,
    }
  }
  return { state: FOLDER_DECLARED, entries: doc, error: null }
}

/**
 * Resolve the folder's entries against the entity pool.
 *
 * Every rule here is a guard, and each one exists because its failure was
 * SILENT. `entries: [artcles]` used to produce a real, reachable, empty path
 * with no warning at all.
 *
 * ⛔ ONE PLACEMENT PER ENTITY. Two entries matching one file is a hard error, not
 * a second placement. The wire could carry many-to-many — `folder.js` nests, and
 * placements are keyed by their `name` chain — but `core/src/where.js`'s
 * `matchUnder` is STRING-ONLY, so a record with two paths would match nothing
 * under `where: { path: { under: … } }`, silently. Widening `under` is a
 * predicate the backend also evaluates natively, so it is a cross-lane change to
 * agree first, not to infer. Until then the file lane is the floor: one folder.
 *
 * @param {Array} entries - the parsed `records.yml` list
 * @param {Array} pool - entities from `readEntityPool`
 * @returns {{ nodes: Array, placements: Map, errors: string[], warnings: string[] }}
 *   `nodes` is the folder tree (branches + entity placements, in file order);
 *   `placements` maps an entity id to its `{ entity, path, slug }`.
 */
export function resolveFolder(entries, pool) {
  const errors = []
  const warnings = []
  const placements = new Map()
  // Which entry claimed a file, so the second one can name the first.
  const claimedBy = new Map()

  const byRelPath = new Map()
  for (const e of pool || []) {
    // ⚠️ KEYED BY THE FILE AS IT EXISTS, prefix and all — an author writing
    // `post/01-lab-opens.md` is naming a file they can see, not the slug it
    // produces. `poolPath` is that path, relative to `entities/`.
    byRelPath.set(e.poolPath, e)
  }

  const place = (entity, pathSegs, where) => {
    const key = entity.id
    const prior = claimedBy.get(key)
    if (prior) {
      errors.push(
        `${RECORDS_YML_RELPATH}: "${entity.relPath}" is placed twice — by ${prior} and by ${where}. ` +
          `An entity occupies one folder; a computed subset is a named query, not a second placement.`
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
      if (!pattern) {
        errors.push(`${RECORDS_YML_RELPATH}: ${where} is an empty string.`)
        return []
      }
      if (!isPattern(pattern)) {
        const hit = byRelPath.get(pattern)
        if (!hit) {
          errors.push(
            `${RECORDS_YML_RELPATH}: ${where} names "${pattern}", which is not in entities/. ` +
              `A bare string is a path under entities/, extension included.`
          )
          return []
        }
        const leaf = place(hit, pathSegs, where)
        return leaf ? [leaf] : []
      }
      // ⛔ A PATTERN MATCHING NOTHING IS AN ERROR. `entities/artcle/*.md` is the
      // old empty-branch defect respelled, and it produced a real, reachable,
      // empty path with no warning.
      const matches = [...byRelPath.entries()]
        .filter(([rel]) => matchEntityPattern(pattern, rel))
        .map(([, e]) => e)
      if (matches.length === 0) {
        errors.push(
          `${RECORDS_YML_RELPATH}: ${where} pattern "${pattern}" matches no entity. ` +
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
      errors.push(`${RECORDS_YML_RELPATH}: ${where} is neither a path nor a typed entry.`)
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
      // ⭐ `name` is the handle (the URL segment, sibling-unique); `label` is the
      // display text. The store renamed the pair on 2026-09-04 — `path_segment` →
      // `name`, and the old `name` (display) → `label` — so one word means one
      // thing from records.yml (`folder:` / `label:`) to the wire to the door's
      // `$name`.
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
        `A bare string is an entity path; anything else says \`folder:\`, \`url:\` or \`asset:\`.`
    )
    return []
  }

  const nodes = (entries || []).flatMap((entry, i) => resolveEntry(entry, [], i, ''))

  // ⚠️ REPORT WHAT NOTHING REFERENCES. It is a legitimate draft state, so it is
  // not an error — but silence is how every defect in this area survived.
  for (const e of pool || []) {
    if (!placements.has(e.id)) {
      warnings.push(
        `${e.relPath} is in entities/ but referenced by nothing in ${RECORDS_YML_RELPATH} — ` +
          `it exists, but it is not a record and no query can reach it.`
      )
    }
  }

  return { nodes, placements, errors, warnings }
}
