// A site's QUERY declarations — the ONE resolution, for every lane.
//
// ⛔ THIS LIVED IN `uwx/` AND THE SITE BUILD COULD NOT SEE IT, so the site build
// used `site.yml::collections` directly and the two disagreed. Measured before the
// move: a collection declared only in `collections/collections.yml` resolved here
// and was INVISIBLE to the build — no `dist/data/<name>.json`, so `data: <name>`
// delivered nothing while sync pushed it fine. Declared in both files, the build
// took `site.yml`'s values and sync took `collections.yml`'s, so an author writing
// `sort: date desc` here got `date asc` baked into the static file.
//
// The broken case was the one the public docs recommend.
//
// ⭐ A QUERY IS SECOND-ORDER SITE CONTENT — it describes how to REACH content, and
// is evaluated rather than rendered. `queries.yml` is a BARE MAP of name → query at
// the site root; `site.yml::queries` is the same vocabulary for a site that would
// rather keep one file. Precedence (per-query, per-key): queries.yml > site.yml.
//
// ⛔ THE THREE JOBS `collections/<name>/` USED TO FUSE ARE NOW THREE THINGS.
// `entities/{schema}/` is the pool, `records.yml` is the folder (what makes an
// entity a record), and a query asks the folder for a set. This file resolves the
// LAST of those only.
//
// ⚠️ `collections.yml` and `site.yml::collections` are GONE, with no alias and no
// deprecation path — the model's §5 ruling, and there is nothing outside this
// workspace on the old paths. Do not reintroduce dual support.
//
// When a query declares no schema, the query-name convention fills it
// (`articles` → `@/articles`). Absent the file entirely, a site simply has no
// queries — and therefore delivers no collection data.

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { briefFields, flatRecordFields } from '@uniweb/schemas/conform'
import { detectFoundationType } from './foundation-ref.js'
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'

// Read its own YAML rather than importing the site build's helper. That import
// pointed the wrong way — a config resolver reaching into the collector that
// consumes it — and became a cycle the moment the site build started calling
// this. Four lines beats a dependency between two modules that should not know
// about each other.
async function readYamlFile(filePath) {
  if (!existsSync(filePath)) return {}
  try {
    return yaml.load(await readFile(filePath, 'utf8')) || {}
  } catch {
    return {}
  }
}

export const QUERIES_YML_RELPATH = 'queries.yml'

// The default data-schema ref for a query that declares none: the query's
// OWN NAME, unchanged. `@/` is the self scope — the local foundation's `schemas/` —
// so this stays backend-independent.
//
// ⛔ IT USED TO APPLY AN ENGLISH SINGULAR RULE to every language. Measured:
// `news` → `@/new`, `series` → `@/sery`, `analyses` → `@/analys`. Right for regular
// English plurals, right-by-accident elsewhere (`noticias` → `noticia`), and inert
// for languages with no plural marker.
//
// ⚠️ The failure was SILENT, which is why the rule was removed rather than improved.
// A default that does not resolve is not an error — the collection soft-skips to
// delivery-only — so a `news` collection simply never synced as entities, and
// nothing said the cause was a guess about English morphology.
//
// A more complete rule would move that boundary, not remove it: every irregular
// list belongs to one language, and a site names its collections in its own.
// Identity has no boundary to get wrong, and an author wanting a different schema
// name writes `schema:`, which is one line and says what it means.
//
// Exported so the inverse (projection) can drop a `schema:` that merely restates
// this default, keeping a projected queries.yml as terse as the author left it.
export function defaultSchema(name) {
  return `@/${name}`
}

// Normalize one query entry (string shorthand or object) to the internal decl shape.
//
// ⛔ NO `path:` IS FILLED IN. A query names a `schema:` and the folder supplies
// the records; `path:`/`source:` mean something only for a REMOTE source, whose
// address nothing local can derive.
function normalizeQueryDecl(name, decl) {
  // ⭐ THE STRING SHORTHAND NAMES THE SCHEMA, because that is what a file-based
  // query actually needs — `entities/{schema}/` supplies the records, so there is
  // no directory left to name. (It named a PATH while the pool was
  // `collections/<name>/` and the same directory answered both questions.)
  if (typeof decl === 'string') return { name, schema: decl }
  const d = decl && typeof decl === 'object' ? decl : {}
  return { name, ...d }
}

// ⛔ `defaultPoolPath` WAS DELETED, NOT KEPT AS A DEFAULT. A file-based query
// carries no `path:` at all now: the pool location is derivable from `schema:` on
// both sides (`site/entity-pool.js::poolDirsForSchema`), so shipping it would be
// emitting a derivation as though the author had written it — the exact defect
// `deferred:` taught. `source:` survives on the wire for REMOTE (`url:`) queries,
// where the address is genuinely external and nothing can derive it.

/**
 * Resolve a site's merged QUERY declarations.
 *
 * @param {string} siteRoot - directory containing site.yml + queries.yml
 * @param {object} [opts]
 * @param {object} [opts.siteYml] - an already-read site.yml (avoids a re-read)
 * @returns {Promise<{
 *   folderSync: boolean,            // vestigial — see below; always true
 *   hasQueriesYml: boolean,
 *   declarations: object,           // { name: decl }  — merged, schema-defaulted
 *   folders: Array|null,            // the folder's virtual org, or null
 * }>}
 */
export async function resolveQueriesConfig(siteRoot, opts = {}) {
  const siteYml = opts.siteYml || (await readYamlFile(join(siteRoot, 'site.yml')))
  const ymlPath = join(siteRoot, QUERIES_YML_RELPATH)
  const hasQueriesYml = existsSync(ymlPath)
  // ⛔ A BARE MAP — `queries.yml` has no root key. The file IS the map, the way
  // `records.yml` IS the list. A `queries:` key inside it would be a name a query
  // could then collide with.
  const queriesYml = hasQueriesYml ? await readYamlFile(ymlPath) : {}

  const declarations = {}

  // site.yml::queries first (lower precedence) — the same vocabulary, for a site
  // that would rather not carry a second file.
  const siteQueries = siteYml?.queries
  if (siteQueries && typeof siteQueries === 'object' && !Array.isArray(siteQueries)) {
    for (const [name, decl] of Object.entries(siteQueries)) {
      declarations[name] = normalizeQueryDecl(name, decl)
    }
  }

  // queries.yml overlay (higher precedence; per-key merge).
  if (queriesYml && typeof queriesYml === 'object' && !Array.isArray(queriesYml)) {
    for (const [name, decl] of Object.entries(queriesYml)) {
      const incoming = normalizeQueryDecl(name, decl)
      declarations[name] = { ...(declarations[name] || {}), ...incoming, name }
    }
  }

  // Schema default (query-name convention) + `model:`→`schema:` synonym.
  // `schemaExplicit` records whether the author asked for this schema: an explicit
  // schema that fails to resolve is a hard error; a convention-defaulted one that
  // fails to resolve soft-skips (so a delivery-only query never breaks sync).
  for (const decl of Object.values(declarations)) {
    if (decl.schema) {
      decl.schemaExplicit = true
    } else if (decl.model) {
      decl.schema = decl.model // migration synonym
      decl.schemaExplicit = true
    } else if (!decl.url) {
      decl.schema = defaultSchema(decl.name) // query-name convention
      decl.schemaExplicit = false
    }
  }

  // ⛔ A `path:` ON A FILE-BASED QUERY DOES NOTHING, so say so. It resolved the
  // pool while the pool was `collections/<name>/`; now `schema:` does, and a key
  // that is quietly inert is how an author spends an afternoon on a query that
  // was reading a different set of files all along. It stays meaningful for a
  // REMOTE source, whose address nothing local can derive.
  for (const decl of Object.values(declarations)) {
    if (decl.path && !decl.url) {
      console.warn(
        `[uniweb] query "${decl.name}": \`path: ${decl.path}\` is ignored. A query names a ` +
          `\`schema:\` and \`entities/{schema}/\` supplies its records — there is no directory ` +
          `for it to name. Move the files under the schema folder instead.`
      )
    }
  }

  await deriveDeferredFromSchemas(siteRoot, siteYml, declarations)

  // ⛔ BOTH OF THESE ARE VESTIGIAL FOR ONE STEP, and deliberately not deleted here.
  //
  //   `folderSync` was `collections.yml::sync`. The model DELETES that mechanism
  //   rather than porting it: "do not sync" becomes "reference nothing in
  //   `records.yml`" — the actual round trip. Its one reader is
  //   `uwx/records.js`, and it goes when `records.yml` supplies the real
  //   control. Until then it must stay TRUE, or nothing syncs at all.
  //
  //   `folders` was `collections.yml::folders`, the virtual org. Its one reader is
  //   `uwx/sync-package.js`, and `records.yml` replaces it. Null meanwhile is the
  //   long-standing default (`folder.js::defaultContents` — one branch per query).
  //
  // ⚠️ Leaving them as literals rather than ripping out their readers keeps this
  // step revertible on its own, which is the whole reason the work is ordered.
  return {
    folderSync: true,
    hasQueriesYml,
    declarations,
    folders: null,
  }
}

/**
 * The declarations as `config.queries` should carry them.
 *
 * `schemaExplicit` records whether the AUTHOR asked for a schema or the
 * subfolder-name convention supplied one. That decides how a failed resolution
 * behaves during sync — hard error vs soft skip — and is nobody's business
 * downstream. It is stripped here rather than at each consumer, so the payload
 * has one shape and no consumer has to know the field existed.
 *
 * Returns undefined for a site with no queries, so `config.queries`
 * stays absent rather than becoming an empty object — an empty object reads as
 * "declared, and empty" to anything checking for presence.
 */
export function toConfigQueries(declarations) {
  const names = Object.keys(declarations || {})
  if (names.length === 0) return undefined
  const out = {}
  for (const name of names) {
    const { schemaExplicit, ...rest } = declarations[name]
    out[name] = rest
  }
  return out
}


/**
 * Fill in `deferred:` from each collection's own data schema.
 *
 * ⭐ A schema's **brief** section already states what a record's summary is — the
 * card, the row, the thing a list shows. Everything else is wanted only when one
 * record is the focus. That is exactly what `deferred:` says, so an author with a
 * schema should not have to say it twice, in a second vocabulary, with nothing
 * checking the two against each other.
 *
 * ⇒ `deferred` = the schema's flat-record fields MINUS its brief fields.
 *
 * Derived from the SCHEMA, never from a record. That is what keeps the
 * build-derived keys safe without a reserved list: `slug`, `route`, `path`,
 * `excerpt`, `image` and `lastModified` are not schema fields, so they are never
 * in the difference and never stripped. `content` is not exempt — it is
 * schema-governed, and usually the heavy field the split exists for.
 *
 * ⛔ Silent on every path that cannot answer, because none of them is an error:
 *
 *   - an author-declared `deferred:` wins outright — this never overrides one;
 *   - no local foundation (a linked or cataloged one), or it is unbuilt → nothing
 *     to read, and a site must still build;
 *   - the schema is not in the foundation's built map → the same soft-skip the
 *     sync lane already applies. `dist/meta/schema.json` carries the schemas
 *     COMPONENTS reference, so a collection whose schema no component binds is
 *     simply not there;
 *   - the schema states no brief (`briefFields` → null, e.g. a root list) → there
 *     is no lean shape to honour, so records stay whole.
 *
 * The last two are why this reads the built artifact rather than resolving
 * schemas itself: it is the same input the sync lane uses, so both lanes agree
 * about which schemas exist.
 */
async function deriveDeferredFromSchemas(siteRoot, siteYml, declarations) {
  const pending = Object.values(declarations).filter(
    (d) => d.schema && !Array.isArray(d.deferred)
  )
  if (pending.length === 0) return

  const dataSchemas = loadFoundationDataSchemas(siteRoot, siteYml)
  if (!dataSchemas) return

  for (const decl of pending) {
    const heavy = deferredFromSchema(dataSchemas[decl.schema])
    if (heavy) decl.deferred = heavy
  }
}

/**
 * The `deferred:` a schema implies — every record field its **brief** does not name.
 *
 * ⛔ ONE IMPLEMENTATION, TWO CALLERS, and that is the point. `deriveDeferredFromSchemas`
 * above uses it to FILL an unstated `deferred:`; `uwx/collections-project.js` uses it to
 * RECOGNIZE a derived value on the way back in, so a pull does not write a derivation
 * into the author's file as though they had typed it.
 *
 * ⚠️ A second copy would drift, and the drift would be invisible: the deriver and the
 * inverter would simply stop agreeing about which values are "the derived one", and the
 * pull would start persisting values it was written to drop.
 *
 * @param {object|undefined} schema a data schema, or undefined when it does not resolve
 * @returns {string[]|null} the implied deferred list, or null when the schema states no
 *   brief (a root list, say) or implies nothing heavy — in both cases there is no
 *   derivation to recognize
 */
export function deferredFromSchema(schema) {
  if (!schema) return null
  const brief = briefFields(schema)
  if (!brief) return null
  const all = Object.keys(flatRecordFields(schema) || {})
  const heavy = all.filter((f) => !brief.has(f))
  return heavy.length ? heavy : null
}

/** The data schemas a site's foundation declares, or null when unresolvable. */
export function foundationDataSchemas(siteRoot, siteYml) {
  return loadFoundationDataSchemas(siteRoot, siteYml)
}

/** The foundation's built data-schema map, or null when there is nothing to read. */
function loadFoundationDataSchemas(siteRoot, siteYml) {
  if (!siteYml?.foundation) return null
  let info
  try {
    info = detectFoundationType(siteYml.foundation, siteRoot)
  } catch {
    return null // a declaration this resolver refuses is not this function's error
  }
  if (info?.type !== 'local' || !info.path) return null
  const schemaPath = join(info.path, 'dist', 'meta', 'schema.json')
  if (!existsSync(schemaPath)) return null
  try {
    return JSON.parse(readFileSync(schemaPath, 'utf8'))?.dataSchemas || null
  } catch {
    return null
  }
}

/** Path to the queries.yml file (whether or not it exists yet). */
export function queriesYmlPath(siteRoot) {
  return join(siteRoot, QUERIES_YML_RELPATH)
}
