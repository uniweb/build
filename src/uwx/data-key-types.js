// ⭐ A NAME THAT IS A DATA KEY, NOT A DATA SCHEMA — its records are of the key's type.
//
// [Diego, 2026-09-25] — *"if team is just a data key for the `@std/member` type and that type
// has a schema, it should not be understood as missing a schema and becoming static data."*
//
// A query that declares no `schema:` takes its own name (`team` → `@/team`), and so does its
// records folder (`records/team/`). When no data schema has that name, but the foundation's
// section types declare the data key of that name with a type — `data: { team: '@/member' }` in a
// `meta.js` — the records ARE of that type: a push sends them as its entities, and the query names
// it on the wire. ⛔ Until 2026-09-25 they were read as having no data schema at all and went out
// as static files, although the one section that reads them declared what they are.
//
// ⚠️ THIS DECIDES ONLY WHICH DATA SCHEMA THE RECORDS BELONG TO. Where they live on disk, how the
// site builds them and how their translations are keyed stay keyed by the name (`team`), as the
// author wrote it — the records are where the author put them, and the query still reads them.
//
// ⛔ A key two section types declare with different types names no type: nothing says which.

import { declaredKeys } from '@uniweb/core/data-keys'

/**
 * The type each data key of a foundation's section types names, where every declaration of the
 * key agrees on one — from its built `schema.json`, whose section types sit at the top level
 * beside `_self` and `dataSchemas`, each with its `data:`.
 *
 * @param {object|null} foundationSchema - a foundation's built `dist/meta/schema.json`
 * @returns {Map<string, string>} data key → its schema ref (`team` → `@/member`)
 */
export function dataKeyTypes(foundationSchema) {
  const types = new Map()
  const conflicted = new Set()
  for (const [name, entry] of Object.entries(foundationSchema || {})) {
    if (name === '_self' || name === 'dataSchemas' || !entry || typeof entry !== 'object') continue
    for (const [key, ref] of declaredKeys(entry.data)) {
      if (!ref) continue
      if (types.has(key) && types.get(key) !== ref) conflicted.add(key)
      else types.set(key, ref)
    }
  }
  for (const key of conflicted) types.delete(key)
  return types
}

/**
 * The data key a name-defaulted ref stands for — `@/team` → `team` — or null for any other ref.
 *
 * @param {unknown} ref
 * @returns {string|null}
 */
export function keyOfDefaultRef(ref) {
  const m = typeof ref === 'string' ? /^@\/([^/]+)$/.exec(ref) : null
  return m ? m[1] : null
}
