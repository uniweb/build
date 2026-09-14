/**
 * Data Fetcher Utilities
 *
 * Parses an authored `fetch:` — a BINDING, which names a query — and executes a
 * resolved config: a compiled `/data/<query>.json` under `public/`, or an external
 * query's address.
 *
 * ⭐ A binding always names a query (ruled 2026-09-13 [Diego]): `fetch: team` and
 * `fetch: [team]` mean `fetch: { query: team }` and `fetch: [{ query: team }]`.
 * The query decides where its records live — the compiled file a static build
 * generates, a host's live records, or an external API — so one declaration
 * debugs locally against static data and reads live records once published,
 * with nothing changed. ⛔ `/data/…` is that generated file, never authored.
 *
 * @module @uniweb/build/site/data-fetcher
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { matchWhere, sortRecords, queryDataUrl, evaluateQuery, whereOutsideLanguage, CURRENT_MODES } from '@uniweb/core'

/**
 * Get a nested value from an object using dot notation
 *
 * @param {object} obj - Source object
 * @param {string} path - Dot-separated path (e.g., 'data.items')
 * @returns {any} The nested value or undefined
 */
function getNestedValue(obj, path) {
  if (!obj || !path) return obj

  const parts = path.split('.')
  let current = obj

  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }

  return current
}

/**
 * Apply a `sort:` to an array of items — `@uniweb/core`'s ONE evaluator, the
 * same the runtime's fallback runs, so a query orders identically on the file
 * lane and over a fetched array.
 *
 * ⛔ SINGLE-KEY, BY RULING [Diego, 2026-09-04]. This was its own implementation
 * until then, and it honoured `order asc, title asc` — a multi-key sort the
 * records service refuses and the ruling dropped. A comma now THROWS here, at build
 * time, which is where an authoring error on the file lane belongs.
 *
 * Texts are collated in `locale` — the page's (ruled 2026-09-14 [Diego]).
 *
 * @param {Array} items - Items to sort
 * @param {string} sortExpr - Sort expression: `date`, `date desc`, `-date`
 * @param {Object} [options]
 * @param {string|null} [options.locale] - the page's locale
 * @returns {Array} Sorted items (new array)
 */
export function applySort(items, sortExpr, { locale = null } = {}) {
  if (!sortExpr || !Array.isArray(items)) return items
  return sortRecords(items, sortExpr, { locale })
}

/**
 * Apply a where-object predicate to an array of items.
 *
 * The where-object is the query language (see @uniweb/core's
 * matchWhere). Structured JSON predicate; the one evaluator walks the
 * object against each record, here at build time and in the runtime
 * alike. The same shape crosses to a host's records service unchanged.
 *
 * @param {Array} items - Items to filter
 * @param {object} where - Where-object predicate
 * @returns {Array} Filtered items in source order
 */
export function applyWhere(items, where) {
  if (!where || !Array.isArray(items)) return items
  return matchWhere(where, items)
}

/**
 * Apply post-processing to fetched data — a resolved config's two levels, by
 * `@uniweb/core`'s `evaluateQuery`, the one order of work the runtime's default
 * fetcher uses too:
 *
 *   1. the query's set — `scope` over each record's placement (`path`), `where`,
 *      `sort`, `limit`;
 *   2. the fetch's `narrow` of it — `where` (and `match`), `sort`, `limit`.
 *
 * A bad `sort:` throws here: an authoring error stops the build.
 *
 * @param {any} data - Fetched data
 * @param {object} config - A resolved fetch config
 * @param {object} [options]
 * @param {string|null} [options.locale] - the page's locale, which texts sort in
 * @returns {any} Processed data
 */
export function applyPostProcessing(data, config, { locale = null } = {}) {
  if (!data || !Array.isArray(data) || !config) return data
  return evaluateQuery(data, config, { locale })
}

/**
 * Normalize a fetch configuration to standard form
 *
 * @param {string|object} fetch - Simple path string or full config object
 * @returns {object|null} Normalized config or null if invalid
 *
 * @example
 * // A query name
 * parseFetchConfig('team')
 * // Returns: { query: 'team', path: '/data/team.json', as: 'team' }
 *
 * // A binding that adapts its query
 * parseFetchConfig({ query: 'articles', as: 'latest', limit: 3, sort: 'date desc' })
 * // Returns: { query: 'articles', path: '/data/articles.json', as: 'latest', limit: 3, sort: 'date desc' }
 */
// ─── Unrecognized-key reporting ───────────────────────────────────────
//
// `parseFetchConfig` reads an explicit allowlist and builds a new object, so
// anything the author wrote that is not on that list is DROPPED — silently,
// with no warning and no trace in the output. A typo (`wehre:`), a field from
// another config block, or a capability the author believed existed all look
// identical to having written nothing.
//
// ⛔ That silence is the defect, not the dropping. We cannot act on a key we do
// not understand, but we can refuse to pretend it was never there. Reported
// once per key name per process so a 200-record build does not print 200 lines.
const RECOGNIZED_FETCH_KEYS = {
  // ⛔ `schema` IS NOT ON EITHER LIST, and its absence is the point. It was the
  // binding key until 2026-09-02 and stopped being READ on 2026-09-03 (`e4fe077`,
  // one name no alias) — but it was left on these lists, which exempted it from
  // the very report this table exists to produce. So the retired spelling was
  // dropped in the one way the author could not see: no warning, and a plausible
  // key inferred from the path in its place. It has its own message below, since
  // "unrecognized" understates a key that used to work.
  // ⛔ `scope` is not a binding key — it is the query's, and refused on a binding
  // (`refuseBindingScope`, ruled 2026-09-13 [Diego]). It was recognized here from
  // 2026-09-11 to 2026-09-13, and replaced the query's scope on the records service.
  // ⛔ `path`, `url`, `method`, `body`, `transform` and `detail` are not binding keys
  // either — a binding names a query, which supplies its source (`refuseBinding`).
  // The source shape that took them (`{ path }`, `{ url }`) was retired on 2026-09-13.
  // ⛔ Nor `merge`, retired 2026-09-14 and refused (`refuseMerge`).
  query: new Set([
    'query', 'as', 'prerender',
    'where', 'limit', 'sort', 'current', 'detailPage',
  ]),
}

/**
 * ⛔ `route:` ON A QUERY IS RETIRED (2026-09-14 [Diego]) — refused, because a query
 * that still declares it would build and its cards would lose their links silently. A
 * record links to the page whose route query is its query, as `$route`, which the
 * runtime fills at render time on every lane; a fetch picks another page with
 * `detailPage:`. The build baked `route:` into each compiled record as `route`, a field
 * in the author's namespace that it overwrote.
 *
 * @param {Object} decl - a query declaration
 * @param {string} context - where the declaration sits, for the message
 */
export function refuseQueryRoute(decl, context) {
  if (!decl || typeof decl !== 'object' || decl.route === undefined) return
  throw new Error(
    `[uniweb] ${context}: \`route:\` is retired. Each record links to the page that shows one record of this ` +
      `query — the \`[slug]\` page whose URL names one of its records — as \`$route\`, with nothing to declare: ` +
      `delete the line, and read \`record.$route\` in a component. To link to another page, add ` +
      `\`detailPage: page:<id>\` to the fetch.`
  )
}

/**
 * ⛔ `under` IS RETIRED (2026-09-11 [Diego]) — refused, like every retired spelling
 * here, because an ignored predicate is a silently wrong answer. It existed for
 * `where: { path: { under: X } }`, a folder branch written before a query had
 * `scope:`; a branch is `scope: X` now, on both lanes, and the evaluator no longer
 * knows the operator, so a `where` still carrying it would match nothing.
 *
 * @param {Object|undefined} where
 * @param {string} context - where the declaration sits, for the message
 */
export function refuseUnder(where, context) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'under')) {
        const instead = key === 'path' && typeof value.under === 'string'
          ? `Write \`scope: ${JSON.stringify(value.under)}\` — the same folder branch, on every lane.`
          : 'A folder branch is `scope:`; `under` is no longer an operator.'
        throw new Error(`[uniweb] ${context}: \`where: { ${key}: { under: … } }\` is retired. ${instead}`)
      }
      walk(value)
    }
  }
  walk(where)
}

/**
 * ⛔ A `where` OUTSIDE THE LANGUAGE STOPS THE BUILD — a retired operator (`like`,
 * `nin`), an unknown one, an empty `and` / `or`, a text operator with an empty
 * argument. Every lane answers such a where with no records (`@uniweb/core`'s
 * `whereOutsideLanguage`), which on a page reads as "nothing matched"; an authoring
 * error is said where the author wrote it instead. ⛔ `like` and `nin` worked in this
 * evaluator until 2026-09-13, when it took the language ruled that day.
 *
 * @param {Object|undefined} where
 * @param {string} context - where the declaration sits, for the message
 */
export function refuseOutsideLanguage(where, context) {
  const problem = whereOutsideLanguage(where)
  if (problem) throw new Error(`[uniweb] ${context}: ${problem}.`)
}

/**
 * ⛔ `scope` ON A BINDING STOPS THE BUILD — ruled 2026-09-13 [Diego]: *"it belongs to
 * the query."* Which branch of the folder a query reads decides what the query is;
 * a binding reuses the query and adapts it with `where`, `sort` and `limit` only.
 * Refused rather than ignored, because ignored it would read as a branch the page
 * narrowed to while the query's whole scope arrived. Every lane reads the query's
 * (`@uniweb/core/fetch-config`).
 *
 * @param {Object|undefined} fetch - one authored binding
 * @param {string} context - where the declaration sits, for the message
 */
export function refuseBindingScope(fetch, context) {
  if (!fetch || typeof fetch !== 'object' || Array.isArray(fetch)) return
  if (fetch.scope === undefined || typeof fetch.query !== 'string') return
  throw new Error(
    `[uniweb] ${context}: \`scope\` is the query's, not a binding's. Put ` +
      `\`scope: ${JSON.stringify(fetch.scope)}\` on the query \`${fetch.query}\` — or declare ` +
      `another query with that scope — and narrow this binding with \`where\`, \`sort\` and \`limit\`.`
  )
}

/**
 * ⛔ `refine: true` IS RETIRED — ruled 2026-09-13 [Diego], for `current:`. It was a flag
 * three methods consulted separately, and it did one thing: on a parametric page,
 * `refine: true, detail: false` delivered the route query's records without the
 * page's own. Its `sort` and `where` changed nothing. `inherit: true`, its earlier
 * spelling, has been refused since 2026-09-02 and now names the same replacement.
 *
 * `current:` is validated here too: one of `only`, `exclude`, `include`, and only on
 * a section's binding — how a page's record is used is a section's choice.
 *
 * @param {Object} fetch - one authored binding
 * @param {string} context - where the declaration sits, for the message
 * @param {'section'|'page'|'site'|null} level - the level it sits at, when known
 */
function refuseRefineAndMisplacedCurrent(fetch, context, level) {
  const retired = fetch.refine !== undefined ? 'refine' : fetch.inherit !== undefined ? 'inherit' : null
  if (retired) {
    throw new Error(
      `[uniweb] ${context}: \`${retired}: true\` is retired. Name the query, and say how this section uses ` +
        `its page's record with \`current:\` — \`fetch: { query: <name>, current: exclude, limit: 3 }\` for ` +
        `the others, \`current: include\` for all of them, \`current: only\` (the default) for the record.`
    )
  }
  if (fetch.current === undefined) return
  if (!CURRENT_MODES.includes(fetch.current)) {
    throw new Error(
      `[uniweb] ${context}: \`current: ${JSON.stringify(fetch.current)}\` — write \`only\`, \`exclude\` or \`include\`.`
    )
  }
  if (level && level !== 'section') {
    throw new Error(
      `[uniweb] ${context}: \`current:\` is read on a section's binding, not on a ${level}'s — ` +
        `each section of a parametric page says how it uses the page's record.`
    )
  }
}

/**
 * ⛔ `limit:` IS A WHOLE NUMBER OF RECORDS, 0 OR MORE — on a query and on a fetch. Every
 * lane cuts a set only by a number above 0 (`@uniweb/core`), so until 2026-09-14
 * `limit: "5"` and `limit: -1` meant no limit and `limit: 2.5` cut to a count nobody
 * wrote, with nothing said. `0` means no limit, and so does a `limit:` with no value
 * (null), as though it were not written.
 *
 * @param {*} limit - the authored `limit`
 * @param {string} context - where the declaration sits, for the message
 */
export function refuseLimit(limit, context) {
  if (limit === undefined || limit === null) return
  if (Number.isInteger(limit) && limit >= 0) return
  const instead =
    typeof limit === 'string' && /^\s*\d+\s*$/.test(limit)
      ? `Write \`limit: ${Number(limit)}\`, unquoted.`
      : Number.isInteger(limit)
        ? 'For no limit, write `limit: 0` or leave it out.'
        : 'Write a count, e.g. `limit: 5`, or leave it out for no limit.'
  throw new Error(
    `[uniweb] ${context}: \`limit: ${JSON.stringify(limit)}\` — \`limit:\` is a whole number of records, 0 or more, ` +
      `and \`0\` means no limit. ${instead}`
  )
}

/**
 * ⛔ `merge:` IS RETIRED (2026-09-14) — refused whatever its value, `false` included.
 * It never combined anything reliably: the build holds no parsed tagged data block for
 * a fetch to merge with, and the prerender asks each key once. What a key receives is
 * settled without it — a fetch fills the key it names, and a tagged data block under a
 * key the component declares fills that key first.
 *
 * @param {Object} fetch - one authored binding
 * @param {string} context - where the declaration sits, for the message
 */
function refuseMerge(fetch, context) {
  if (fetch.merge === undefined) return
  throw new Error(
    `[uniweb] ${context}: \`merge:\` is retired — a fetch fills the key it names, and a tagged data block under a key ` +
      `the component declares fills it first. Delete the \`merge:\` line.`
  )
}

/**
 * ⭐ WHAT A BINDING MAY NOT SAY — every refusal, in one place, for the two readers
 * of an authored binding: the build's parse (`parseFetchConfig`) and the sync push,
 * which carries a page's declaration without parsing it (`uwx/site.js`). A site
 * that cannot build must not sync either.
 *
 * @param {Object} fetch - one authored binding
 * @param {string} context - where the declaration sits, for the message
 * @param {Object} [options]
 * @param {'section'|'page'|'site'|null} [options.level] - the level it sits at, when known
 */
export function refuseBinding(fetch, context, { level = null } = {}) {
  if (fetch === null || fetch === undefined) return
  if (typeof fetch === 'string') {
    refuseQueryName(fetch, context)
    return
  }
  if (typeof fetch !== 'object' || Array.isArray(fetch)) return
  refuseRefineAndMisplacedCurrent(fetch, context, level)
  refuseMerge(fetch, context)
  refuseSourceKeys(fetch, context)
  if (fetch.collection === undefined) refuseQueryName(fetch.query, context, { object: true })
  refuseUnder(fetch.where, context)
  refuseOutsideLanguage(fetch.where, context)
  refuseBindingScope(fetch, context)
  refuseLimit(fetch.limit, context)
}

/**
 * A binding's string, or the string it has for `query:` — is it a query name?
 *
 * ⛔ A NAME, NOT A PATH — ruled 2026-09-13 [Diego]: *"Referencing "/data" is never
 * allowed."* `/data/<name>.json` is the file the build generates from a query for a
 * site with no backend to answer it; naming the query is what lets the same page read
 * that file locally and a host's live records once published. So a string with a
 * slash, or a data file's extension, is refused rather than looked up as a name.
 *
 * @param {*} name
 * @param {string} context
 * @param {{ object?: boolean }} [options] - whether it came from `{ query: … }`
 */
function refuseQueryName(name, context, { object = false } = {}) {
  if (typeof name === 'string' && name.trim() !== '' && !/[\\/]|\.(json|ya?ml)$/i.test(name)) return
  if (typeof name === 'string' && name.trim() !== '') {
    const guess = name.replace(/^.*[\\/]/, '').replace(/\.(json|ya?ml)$/i, '')
    throw new Error(
      `[uniweb] ${context}: ${object ? `\`query: ${JSON.stringify(name)}\`` : `\`fetch: ${JSON.stringify(name)}\``} — a fetch ` +
        `names a query, and a query name is not a path. \`/data/…\` is the file the build generates from a query ` +
        `for a site with no backend; declare the query in queries.yml and name it${guess ? ` — \`query: ${guess}\`` : ''}.`
    )
  }
  throw new Error(
    `[uniweb] ${context}: a fetch names a query — \`fetch: { query: <name>, … }\`, or the shorthand \`query: <name>\`. ` +
      `Declare the query in queries.yml.`
  )
}

/**
 * ⛔ A BINDING HAS NO SOURCE OF ITS OWN — ruled 2026-09-13 [Diego]. `path:` is the
 * generated file (above); `url:`, `method:`, `body:` and `transform:` describe an
 * external source, which is a named query (*"Making the external source a named query
 * is smart"*) — so every one a site uses is listed in one file; and `detail:` is
 * `current:` on a parametric page's section, or `record:` on an external query.
 *
 * @param {Object} fetch - one authored binding
 * @param {string} context
 */
function refuseSourceKeys(fetch, context) {
  if (fetch.path !== undefined) {
    throw new Error(
      `[uniweb] ${context}: \`path:\` is not a fetch key — a fetch names a query, and \`/data/…\` is the file the ` +
        `build generates from one for a site with no backend. ` +
        (typeof fetch.query === 'string' ? 'Delete the `path:` line.' : 'Declare a query in queries.yml and write `query: <name>`.')
    )
  }
  for (const key of ['url', 'method', 'body', 'transform']) {
    if (fetch[key] === undefined) continue
    throw new Error(
      `[uniweb] ${context}: \`${key}:\` belongs on an external query, not on a fetch. Declare it in queries.yml — ` +
        `\`<name>: { url: …${key === 'url' ? '' : `, ${key}: …`} }\` — and name it here with \`query: <name>\`.`
    )
  }
  if (fetch.detail !== undefined) {
    throw new Error(
      `[uniweb] ${context}: \`detail:\` is retired. On a section of a parametric page, say how it uses the page's ` +
        `record with \`current:\`; for an API's single-record endpoint, declare \`record: { url: … }\` on its external query.`
    )
  }
}

/**
 * ⚠️ TWO BINDINGS UNDER ONE KEY AT ONE LEVEL — ruled 2026-09-13 [Diego]: *"Duplicates
 * should not exist."* The first is used on every lane (`resolveFetchConfigs` keeps
 * the first per key, and so does the build's prerender) and the rest are ignored;
 * this says so once per key per file. Warned, not refused: the first binding still
 * delivers what it says.
 *
 * @param {Array<Object>} list - one level's bindings, parsed or as authored
 * @param {string} context - where the declaration sits, for the message
 */
const warnedDuplicateBindings = new Set()
export function warnDuplicateBindings(list, context) {
  if (!Array.isArray(list)) return
  const seen = new Set()
  for (const one of list) {
    const key = one && typeof one === 'object' ? (one.as || one.query) : undefined
    if (typeof key !== 'string' || !key) continue
    if (!seen.has(key)) {
      seen.add(key)
      continue
    }
    const memo = `${context}::${key}`
    if (warnedDuplicateBindings.has(memo)) continue
    warnedDuplicateBindings.add(memo)
    console.warn(
      `[uniweb] ${context}: more than one binding delivers content.data.${key} — the first is used ` +
        `and the rest are ignored. Give each binding its own \`as:\`.`
    )
  }
}

/** Test seam — reset the duplicate-binding memo so suites do not leak into each other. */
export function _resetDuplicateBindingWarnings() {
  warnedDuplicateBindings.clear()
}

// Keys that are neither recognized nor merely unknown: they USED to work, and a
// generic "unrecognized key" line understates that. Each has a dedicated message
// naming its replacement, so this table only has to keep the generic report from
// firing a second, vaguer time on the same key.
//
// ⛔ This is not the recognized list wearing another name. A key here is still
// dropped from the parsed config; what it buys is a better sentence.
const RETIRED_FETCH_KEYS = new Set(['schema'])

const warnedUnknownFetchKeys = new Set()

function warnUnknownFetchKeys(fetch, shape) {
  const recognized = RECOGNIZED_FETCH_KEYS[shape]
  for (const key of Object.keys(fetch)) {
    if (recognized.has(key)) continue
    if (RETIRED_FETCH_KEYS.has(key)) continue
    const seenKey = `${shape}:${key}`
    if (warnedUnknownFetchKeys.has(seenKey)) continue
    warnedUnknownFetchKeys.add(seenKey)
    console.warn(
      `[uniweb] fetch: unrecognized key "${key}" was ignored. ` +
        `Keys recognized on this declaration: ${[...recognized].sort().join(', ')}.`
    )
  }
}

/** Test seam — reset the once-per-key memo so suites do not leak into each other. */
export function _resetUnknownFetchKeyWarnings() {
  warnedUnknownFetchKeys.clear()
}

/**
 * Normalize a parsed `fetch` to a list. **Use this at every consumption point.**
 *
 * `parseFetchConfig` returns an object for one declaration and an array for
 * several, so `cfg.path` on a multi-fetch page reads `undefined` rather than
 * throwing — the silent-empty class. Reaching for this instead of a property is
 * what keeps that from happening.
 *
 * @param {Object|Array|null} fetch - a PARSED fetch (post-`parseFetchConfig`).
 * @returns {Array<Object>} zero, one, or many configs.
 */
export function toFetchList(fetch) {
  if (!fetch) return []
  return Array.isArray(fetch) ? fetch : [fetch]
}

/**
 * Parse a `fetch:` (or desugared `query:`) declaration.
 *
 * ⭐ **A LIST MEANS "FETCH EACH".** `query: [team, articles]` declares two needs
 * and they land under two keys in `content.data` — a component reads
 * `content.data.team` and `content.data.articles` independently, so the
 * declaration is plural by necessity.
 *
 * ⚖️ **Plural DECLARATIONS are not plural REQUESTS.** How many round trips this
 * becomes belongs to the fetcher: `EntityStore` already assembles every config
 * before dispatching any of them and awaits them together, which is exactly
 * where a batching source would coalesce. Nothing here should encode a
 * transport assumption — the file lane genuinely has two artifacts, and most
 * sources cannot batch at all.
 *
 * ⛔ **A one-entry list collapses to an object, deliberately.** The returned
 * shape reflects the cardinality of the RESULT, not of the input syntax, so
 * every declaration that resolves to a single fetch is byte-identical to what
 * this emitted before — the array shape appears only where content could not
 * previously have worked. (Before 2026-09-02 a list kept `[0]` and discarded the
 * rest silently, so the only content whose shape changes is content that was
 * already broken.)
 *
 * @param {string|Object|Array|null} fetch
 * @param {string} [context='fetch'] - where the declaration sits (a file), for messages
 * @param {Object} [options]
 * @param {'section'|'page'|'site'|null} [options.level] - the level it sits at, when known
 * @returns {Object|Array<Object>|null}
 */
export function parseFetchConfig(fetch, context = 'fetch', { level = null } = {}) {
  if (!fetch) return null

  if (Array.isArray(fetch)) {
    const parsed = fetch.map((f) => parseFetchConfig(f, context, { level })).filter(Boolean)
    // Flatten: a nested array is not a meaningful authoring shape, and letting
    // one through would put an array inside an array where every consumer
    // expects configs.
    const flat = parsed.flat()
    if (flat.length === 0) return null
    warnDuplicateBindings(flat, context)
    return flat.length === 1 ? flat[0] : flat
  }

  // ⭐ A STRING IS A QUERY NAME — `fetch: team` ≡ `fetch: { query: team }`.
  if (typeof fetch === 'string') {
    refuseBinding(fetch, context, { level })
    return parseFetchConfig({ query: fetch }, context, { level })
  }

  if (typeof fetch !== 'object') return null

  // ⛔ RETIRED SPELLINGS ARE ERRORS, NOT WARNINGS — ignored, a declaration falls
  // through to a shape it is not and resolves to null: a silently empty block.
  refuseBinding(fetch, context, { level })

  // ⛔ THE RETIRED SPELLING IS AN ERROR, NOT A WARNING. An unrecognized key is
  // warned about and IGNORED, so `fetch: { collection: X }` would fall through to
  // the source shape, find neither `path` nor `url`, and resolve to null — a
  // SILENTLY EMPTY result, which is worse than the old name simply working. The
  // author sees a page render with no data and nothing saying why.
  if (fetch.collection !== undefined) {
    throw new Error(
      `[uniweb] fetch: \`collection: ${JSON.stringify(fetch.collection)}\` is retired. ` +
        `Write \`query: ${JSON.stringify(fetch.collection)}\` and declare it in queries.yml. ` +
        `A query names a schema and the folder supplies its records.`
    )
  }

  // A binding: { query: 'articles', limit: 3 }
  warnUnknownFetchKeys(fetch, 'query')
  warnSchemaRetired(fetch, fetch.as || fetch.query)
  return {
    // ⭐ **`query` IS EMITTED, and that is what makes the two producers agree.**
    // The sync lane has always emitted it (`uwx/site.js`) and this one did not,
    // for the same declaration — so `resolveQuerySource` fired on a published
    // site and never on a `--link`-deployed one. Measured 2026-09-02 against a
    // host offering the `records` service:
    //
    //   --link   endpoint undefined, path /data/articles.json   ← the STATIC file
    //   publish  endpoint /_api/q/articles                       ← the live lane
    //
    // Same site, same declaration, two verbs, two data sources. Publishing to a
    // platform that declares a live lane is supposed to READ from it — the
    // compiled `/data/*.json` is the escape hatch for entities with no known
    // data schema, which never sync, not a second way to serve the ones that do.
    //
    // ⚠️ Not in the cache key: `deriveCacheKey` hashes {path,url,endpoint,schema,
    // transform}, so adding this moves no cached entry.
    query: fetch.query,
    // The compiled file's address, for a consumer that cannot resolve the query —
    // derived, never authored (`refuseSourceKeys`).
    path: queryDataUrl(fetch.query),
    // ⭐ **`as` is the BINDING KEY** — the `content.data.<key>` a component
    // reads — defaulting to the query name. It was called `schema` until
    // 2026-09-02, which collided with the MODEL REF of the same name on a
    // `queries` declaration. ⛔ **The old spelling is NOT read here, by
    // ruling (2026-09-03): one name, no alias.** A fetch authored as
    // `schema: posts` binds to nothing and is re-authored, not translated.
    as: fetch.as || fetch.query,
    // ⚠️ Only when authored: its default depends on the query — a query over the
    // site's records is prerendered, an external query is the browser's
    // (`@uniweb/core/fetch-config`) — and the parser does not know which this is.
    prerender: fetch.prerender,
    // A binding's adaptations of its query, kept as authored: the resolver makes them
    // the fetch's `narrow` of the query's set (`@uniweb/core/fetch-config`,
    // `setAndNarrow`) — its `where` filters the set, its `sort` re-orders it, its
    // `limit` cuts it and never reaches past it.
    where: fetch.where,
    limit: fetch.limit,
    sort: fetch.sort,
    // How a section on a parametric page uses the page's record (`currentOf`).
    current: fetch.current,
    // Canonical detail page for a list card's href (page:<stable_id> ref;
    // resolved to a route template + interpolated per record at runtime).
    detailPage: fetch.detailPage,
  }
}

/**
 * Report a fetch still authored with the retired `schema:` binding key.
 *
 * ⭐ **It names the key the fetch ACTUALLY bound to, and that is the whole
 * value of this message.** `schema:` is not read (ruling 2026-09-03, `e4fe077`):
 * the binding key falls back to the query name or to `inferSchemaFromPath`, so
 * the data still arrives — under a *different* `content.data` key. The component
 * reads `?.weather`, gets `undefined`, and renders empty with nothing anywhere
 * saying why. A bare "unrecognized key" would not close that gap; the inferred
 * name does, because the reader can see at once whether it happens to match.
 *
 * ⚠️ Measured 2026-09-03, `templates/dynamic`: five of six sections rendered
 * empty this way, one of them from a URL whose last segment is empty
 * (`randomuser.me/api/?results=6` → `as: ''`), which is falsy and drops the
 * config outright. That template shipped with no warning of any kind, because
 * `schema` was left on the recognized list when it stopped being read.
 *
 * Once per distinct (written → bound) pair: several files each get their own
 * line, one file repeated across 200 records does not.
 */
const warnedRetiredSchema = new Set()
function warnSchemaRetired(fetch, boundTo) {
  if (fetch?.schema === undefined) return
  const wrote = String(fetch.schema)
  const bound = boundTo === '' || boundTo === undefined ? '(nothing)' : String(boundTo)
  const seen = `${wrote}→${bound}`
  if (warnedRetiredSchema.has(seen)) return
  warnedRetiredSchema.add(seen)
  console.warn(
    `[uniweb] fetch: 'schema: ${wrote}' is retired as the binding key and is NOT read. ` +
      `This fetch binds to content.data.${bound} instead. Write 'as: ${wrote}'. ` +
      "(On a `queries:` declaration `schema:` is a different, current key — the Model ref.)"
  )
}

/** Test seam — reset the retired-`schema:` memo so suites do not leak into each other. */
export function _resetRetiredSchemaWarnings() {
  warnedRetiredSchema.clear()
}

// ⛔ NO BUILD-ONLY FETCH KEYS, AND NO STRIP. `stripBuildOnlyFetchKeys` removed `merge`
// from every shipped payload after the build had read it; `merge` was its only key, and
// with it retired (2026-09-14, `refuseMerge`) the parse emits nothing a runtime does not
// read, so there is nothing left to strip.

/**
 * Execute a fetch operation
 *
 * @param {object} config - A resolved fetch config (`resolveFetchConfigs`): a compiled
 *   `path`, or an external query's `url` with its `method`, `body` and `transform`
 * @param {object} options - Execution options
 * @param {string} options.siteRoot - Site root directory
 * @param {string} [options.publicDir='public'] - Public directory name
 * @param {string|null} [options.locale] - the page's locale, which a `sort` collates texts in
 * @returns {Promise<{ data: any, error?: string }>} Fetched data or error
 *
 * @example
 * const result = await executeFetch(
 *   { path: '/data/team.json', schema: 'team' },
 *   { siteRoot: '/path/to/site' }
 * )
 * // result.data contains the parsed JSON
 *
 * @example
 * // With post-processing
 * const result = await executeFetch(
 *   { path: '/data/articles.json', limit: 3, sort: 'date desc' },
 *   { siteRoot: '/path/to/site' }
 * )
 * // result.data contains the 3 most recent articles
 */
export async function executeFetch(config, options = {}) {
  if (!config) return { data: null }

  const { path, url, transform } = config
  const { siteRoot, publicDir = 'public' } = options

  try {
    let data

    if (path) {
      // Local file from public/
      const filePath = join(siteRoot, publicDir, path)

      if (!existsSync(filePath)) {
        console.warn(`[data-fetcher] File not found: ${filePath}`)
        return { data: [], error: `File not found: ${path}` }
      }

      const content = await readFile(filePath, 'utf8')

      // Parse based on extension
      if (path.endsWith('.json')) {
        data = JSON.parse(content)
      } else if (path.endsWith('.yaml') || path.endsWith('.yml')) {
        data = yaml.load(content, YAML_OPTIONS)
      } else {
        // Try JSON first, then YAML
        try {
          data = JSON.parse(content)
        } catch {
          data = yaml.load(content, YAML_OPTIONS)
        }
      }
    } else if (url) {
      // An external query's address — a GET, or a POST with a JSON body, as the
      // runtime's default fetcher sends it.
      const post = typeof config.method === 'string' && config.method.toUpperCase() === 'POST'
      const init = post
        ? {
            method: 'POST',
            ...(config.body !== undefined && config.body !== null
              ? { headers: { 'Content-Type': 'application/json' }, body: typeof config.body === 'string' ? config.body : JSON.stringify(config.body) }
              : {}),
          }
        : undefined
      const response = await globalThis.fetch(url, init)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      data = await response.json()
    }

    // Apply transform if specified (extract nested data)
    if (transform && data) {
      data = getNestedValue(data, transform)
    }

    // Apply post-processing (where, sort, limit)
    data = applyPostProcessing(data, config, { locale: options.locale ?? null })

    // Ensure we return an array or object, defaulting to empty array
    return { data: data ?? [] }
  } catch (error) {
    console.warn(`[data-fetcher] Fetch failed: ${error.message}`)
    return { data: [], error: error.message }
  }
}

/**
 * Put fetched data into a content object, under the key its fetch names.
 *
 * It REPLACES what the key held. ⛔ A fourth `merge` argument concatenated arrays and
 * spread objects into what was there until 2026-09-14, for the retired `merge:` fetch
 * key (`refuseMerge`); it is no longer read.
 *
 * @param {object} content - Existing content object with data property
 * @param {any} fetchedData - Data from fetch
 * @param {string} schema - the key to store under — the fetch's `as`
 * @returns {object} Updated content object (a copy; the input is not mutated)
 *
 * @example
 * mergeDataIntoContent({ data: { team: [{ name: 'Local' }] } }, [{ name: 'Remote' }], 'team')
 * // → { data: { team: [{ name: 'Remote' }] } }
 */
export function mergeDataIntoContent(content, fetchedData, schema) {
  if (fetchedData === null || fetchedData === undefined || !schema) {
    return content
  }
  return {
    ...content,
    data: { ...(content.data || {}), [schema]: fetchedData },
  }
}

/**
 * Execute multiple fetch operations in parallel
 *
 * @param {object[]} configs - Array of normalized fetch configs
 * @param {object} options - Execution options (same as executeFetch)
 * @returns {Promise<Map<string, any>>} Map of binding key (`as`) -> data
 */
export async function executeMultipleFetches(configs, options = {}) {
  if (!configs || configs.length === 0) {
    return new Map()
  }

  const results = await Promise.all(
    configs.map(async (config) => {
      const result = await executeFetch(config, options)
      return { schema: config.as, data: result.data }
    })
  )

  const dataMap = new Map()
  for (const { schema, data } of results) {
    if (data !== null) {
      dataMap.set(schema, data)
    }
  }

  return dataMap
}
