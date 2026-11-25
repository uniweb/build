/**
 * ONE KEY'S ANSWER, MERGED FROM TWO SOURCES — a project's record files and a backend's public
 * records — as a site's records service merges a site's own records with its backend's.
 *
 * `uniweb dev` answers a site's records questions itself when its `$devBackend` names a backend's
 * records address (`./records-mount.js`). Each question goes to both sources whole; each answers at
 * most what the question asks, in the question's order; this merges the two per key:
 *
 *   1. **identity**: a record of the same `$uuid` in both is kept once, the files' copy. A record
 *      with no `$uuid` is always kept. (A project's record files carry none, so locally this keeps
 *      every file record.)
 *   2. **order**: the sort used is the question's `narrow.sort`, else its `sort`. The merged list is
 *      re-sorted by it when at least one record holds a value there, by the records service's
 *      comparator (`@uniweb/core/sort`'s `sortRecords`: no value last in either direction, texts in
 *      the question's locale). A `date` sort re-sorts only when the files' records hold `date` as a
 *      field. Otherwise, and with no sort, the order is the files' records, then the backend's.
 *   3. **the cut**: the smaller of `limit` and `narrow.limit`, after ordering.
 *   4. **whole**: whole when every source that delivered records delivered them whole; with none,
 *      the files' answer, else what the question asked.
 *   5. **paging**: a cursor only when exactly one source delivered records, resuming that source.
 *   6. **a backend that doesn't answer**: the key is the files' answer, reported as `partial`.
 *
 * These are the rules a site's records service follows; the vectors in `tests/dev-records-merge.test.js`
 * are the ones it is checked against.
 *
 * @module
 */

import { sortRecords, parseSort } from '@uniweb/core/sort'

/**
 * @typedef {Object} SourceAnswer
 * @property {Array<Object>} records - what the source answered for the key, in the question's order
 * @property {boolean} [whole] - whether it answered whole records
 * @property {*} [cursor] - where it would resume, when more remain
 */

/**
 * @param {Object} question - the key's question, as the page sent it
 * @param {Object} sources
 * @param {SourceAnswer|null} sources.files - null when the files were not asked (a page of the backend's)
 * @param {SourceAnswer|null} sources.engine - null when it was not asked or did not answer
 * @param {string|null} [locale] - the question's locale, which texts are ordered in
 * @returns {{ records: Array<Object>, whole: boolean, cursor: { source: 'files'|'engine', at: * }|null }}
 */
export function mergeKey(question, { files = null, engine = null }, locale = null) {
  const fileRecords = files?.records || []
  const engineRecords = engine?.records || []

  // 1 · identity — the files first, then the backend's, the first of each `$uuid` kept.
  const seen = new Set()
  const merged = []
  for (const record of [...fileRecords, ...engineRecords]) {
    const id = record && typeof record === 'object' ? record.$uuid : undefined
    if (id !== undefined && id !== null && id !== '') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    merged.push(record)
  }

  // 2 · order
  let ordered = merged
  const sort = question?.narrow?.sort ?? question?.sort
  const spec = safeParse(sort)
  if (spec) {
    const resort =
      spec.field === 'date'
        ? fileRecords.some((r) => hasValue(readPath(r, 'date')))
        : merged.some((r) => hasValue(readPath(r, spec.field)))
    if (resort) ordered = sortRecords(merged, sort, { locale: firstTag(locale) })
  }

  // 3 · the cut
  const bound = [question?.limit, question?.narrow?.limit].filter((n) => typeof n === 'number' && n > 0)
  if (bound.length) ordered = ordered.slice(0, Math.min(...bound))

  // 4 · whole
  const contributors = [
    fileRecords.length ? { source: 'files', answer: files } : null,
    engineRecords.length ? { source: 'engine', answer: engine } : null,
  ].filter(Boolean)
  const whole = contributors.length
    ? contributors.every((c) => c.answer.whole === true)
    : files
      ? files.whole === true
      : question?.whole === true

  // 5 · paging
  const only = contributors.length === 1 ? contributors[0] : null
  const cursor = only && only.answer.cursor != null ? { source: only.source, at: only.answer.cursor } : null

  return { records: ordered, whole, cursor }
}

/** A list of tags (`es,en`) collates by its first. */
function firstTag(locale) {
  return typeof locale === 'string' && locale ? locale.split(',')[0].trim() || null : null
}

function safeParse(sort) {
  try {
    return parseSort(sort)
  } catch {
    return null
  }
}

/** A value a record can be ordered by: not missing, `null`, `""` or a list — the comparator's "no value". */
function hasValue(v) {
  if (v === undefined || v === null || v === '') return false
  return !Array.isArray(v)
}

function readPath(record, path) {
  if (!record || typeof record !== 'object') return undefined
  let at = record
  for (const segment of path.split('.')) {
    if (at == null || typeof at !== 'object') return undefined
    at = at[segment]
  }
  return at
}
