/**
 * What to tell an author whose record holds a field its data schema has no place for: one wording
 * for `uniweb validate` (`validate-data.js`), which reports it, and for the push
 * (`uwx/records.js`), which refuses it. The rule that finds such a field is `@uniweb/schemas/conform`'s
 * `undeclaredFields`.
 *
 * ⭐ WHO CAN CHANGE THE TYPE DECIDES THE ADVICE. A type the site's foundation defines (`@/x`, or
 * a name in its scope) can be given the field. A standard type (`@std/x`), or a type of another
 * scope, cannot be changed from the site: the advice names the fields it has and a type of the
 * site's own. ⛔ Until 2026-11-11 the push said "Declare it in the schema" for every type, which
 * nobody whose records are `@std/testimonial` can do.
 */

/**
 * Whether the site's foundation defines a type, and so can declare a field on it.
 *
 * @param {string} type - the type as a record's folder or query names it (`@/member`, `@std/article`)
 * @param {string|null} scope - the foundation's scope, with or without its `@`; null when unknown
 * @returns {boolean}
 */
export function ownsType(type, scope) {
  if (typeof type !== 'string') return true
  if (type.startsWith('@/')) return true
  const bare = typeof scope === 'string' ? scope.replace(/^@/, '') : ''
  return bare !== '' && type.startsWith(`@${bare}/`)
}

/**
 * The advice for one record's undeclared fields: declare or remove them, for a type the site
 * owns; otherwise what the type has, and a type of the site's own.
 *
 * @param {Object} params
 * @param {string} params.type - the type, as it is named to the author
 * @param {boolean} params.owned - `ownsType`
 * @param {string[]} [params.declared] - the names the type has where the fields were written
 * @param {number} [params.count=1] - how many fields the advice is about
 * @returns {string}
 */
export function undeclaredAdvice({ type, owned, declared = [], count = 1 }) {
  const it = count === 1 ? 'it' : 'them'
  if (owned) return `Declare ${it} in the schema, or remove ${it}.`
  const which = type.startsWith('@std/') ? `${type} is a standard type` : `${type} is defined outside this site's foundation`
  const values = count === 1 ? 'the value' : 'the values'
  const has = declared.length ? ` It has ${listOf(declared)}: move ${values} into one of those,` : ''
  return (
    `${which}, and a site cannot add a field to it.${has}${has ? '' : ' Either'} remove ${it}, or ` +
    'give these records a type of your own (`schemas/<name>.yml` in the foundation, the records in `records/<name>/`).'
  )
}

/**
 * `a`, `a and b`, `a, b and c`.
 *
 * @param {string[]} items
 * @returns {string}
 */
export function listOf(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
