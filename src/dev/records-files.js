/**
 * A records question, answered from the project's record files as `uniweb dev` compiles them — the
 * files' half of the dev server's records service (`./records-mount.js`).
 *
 * The answer is the one a page gets from the same files with no records service: the query's
 * compiled list (`/data/<query>.json`, translated for a language as the dev server translates it),
 * evaluated by `@uniweb/core`'s `evaluateQuery` — the set, then the narrowing — and, for a whole
 * question, each record's own file (`/data/<query>/<$name>.json`). So a page reads the same records
 * from its files whether or not a backend's records are merged in.
 *
 * ⭐ WHICH QUERY'S FILE. A question names its type, not its query, so the file is the one of the
 * site's query of that type whose name is the question's key — the key a page asks under is the
 * query's name unless it binds another — else the first of that type. The question carries the
 * query as saved, so evaluating it over that file applies nothing the file has not been made for.
 * A type no query of the site reads has no file, and its answer from the files is `[]`.
 *
 * @module
 */

import { evaluateQuery } from '@uniweb/core'

/**
 * @param {object} p
 * @param {string} p.key - the key the page asked under
 * @param {object} p.question - its question
 * @param {string} p.locale
 * @param {Record<string, object>} p.queries - the site's queries, their types named in full
 * @param {(locale: string, file: string) => Promise<*>} p.read - a compiled file under `/data/`, as
 *   the dev server serves it in `locale`, or null when there is none
 * @param {number} [p.offset] - where a page of the files' own resumes
 * @returns {Promise<{ records: object[], whole: boolean, cursor: number|null }>}
 */
export async function answerFromFiles({ key, question, locale, queries, read, offset = 0 }) {
  const asked = question?.whole === true
  const name = queryFor(key, question?.schema, queries)
  if (!name) return { records: [], whole: asked, cursor: null }

  const list = await read(locale, `${name}.json`)
  if (!Array.isArray(list)) return { records: [], whole: asked, cursor: null }

  const { cursor: _cursor, limit: pageSize, ...narrow } = question.narrow || {}
  const set = evaluateQuery(
    list,
    {
      scope: question.scope,
      where: question.where,
      sort: question.sort,
      limit: question.limit,
      narrow: Object.keys(narrow).length ? narrow : undefined,
    },
    { locale }
  )

  const start = Number.isInteger(offset) && offset > 0 ? offset : 0
  const size = typeof pageSize === 'number' && pageSize > 0 ? pageSize : null
  const page = size ? set.slice(start, start + size) : set.slice(start)
  const cursor = size && start + size < set.length ? start + size : null

  if (!asked) return { records: page, whole: false, cursor }
  // Whole: each record's own file, which holds it as stored.
  let whole = true
  const records = await Promise.all(
    page.map(async (record) => {
      const handle = record?.$name
      const own = handle ? await read(locale, `${name}/${handle}.json`) : null
      if (own && typeof own === 'object') return own
      whole = false
      return record
    })
  )
  return { records, whole, cursor }
}

/** The site's query a question of `schema` asked under `key` reads: the one named `key`, else the first of the type. */
function queryFor(key, schema, queries) {
  if (!queries || typeof queries !== 'object' || typeof schema !== 'string') return null
  const of = Object.entries(queries).filter(([, q]) => q && typeof q === 'object' && q.url === undefined && q.schema === schema)
  if (!of.length) return null
  return (of.find(([name]) => name === key) || of[0])[0]
}
