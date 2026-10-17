/**
 * ⭐ WHAT A SECTION TYPE SAYS ITS DATA BLOCKS ARE. A tagged data block (```yaml:logos) feeds the
 * data key of its tag, and the section's type declares that key in its `meta.js` `data:` — a data
 * schema ref (`'@/member'`), an inline field map (`{ name: 'string', style: { type: 'string', enum:
 * [...] } }`), or nothing said (`{}`). The foundation's `main.js` `data:` reaches every section, and
 * a key both declare is the section type's (`@uniweb/core/data-keys::declaredKeys`).
 *
 * This is the model of each declared shape, lowered by the push's own rule (`records.js::modelOf`),
 * so the fields a block translates are the ones its model marks `localized`
 * (`data-strings.js::visitDataBlockStrings`). Every form of a declaration is read by the one
 * normalizer (`@uniweb/schemas/foundation::normalizeData`); a ref resolves as a query's records
 * resolve theirs (`resolveRecordSchemas`). A key with no shape, or a ref that does not resolve, has
 * no model, and its blocks keep the heuristic.
 *
 * ⛔ A key that DOES declare a shape, which the translation step cannot read, is said aloud
 * (`warnUnreadable`): its blocks fall back to the heuristic, which never offers a field named
 * `email`, `time`, `href` and the like. ⛔ Until 2026-10-16 that fall was silent — measured on a
 * block of contact labels declared `{ type: 'object', values: { type: 'string' } }`, whose `email`
 * and `time` labels were never offered for translation.
 */
import { normalizeData } from '@uniweb/schemas/foundation'
import { foundationSections, resolveRecordSchemas } from '../site/queries-config.js'
import { modelOf } from './records.js'

/** The lookup when there is no foundation to ask: every block keeps the heuristic. */
export const NO_DATA_MODELS = () => null

/**
 * The lookup for a site: `(sectionType, tag) => model | null`.
 *
 * @param {string} siteRoot
 * @param {object} [siteYml] - an already-read site.yml
 * @returns {Promise<(type: string, tag: string) => object|null>}
 */
export async function dataBlockModels(siteRoot, siteYml = null) {
  // Each key's declaration as written, to say what was meant when its shape cannot be read.
  const raw = new Map()
  const warn = (where, reason) => warnUnreadable(siteRoot, where, reason, raw.get(where))
  let sections
  try {
    sections = await foundationSections(siteRoot, siteYml)
  } catch {
    return NO_DATA_MODELS
  }
  if (!sections || typeof sections !== 'object') return NO_DATA_MODELS

  // Each declared key, by who declares it: a section type by name, the foundation as ''.
  const declared = new Map()
  const declare = (owner, data) => {
    const normalized = normalizeData(data, { strict: false })
    for (const [key, decl] of Object.entries(normalized || {})) {
      declared.set(at(owner, key), decl)
      raw.set(at(owner, key), data?.[key])
    }
  }
  for (const [name, entry] of Object.entries(sections)) {
    if (!entry || typeof entry !== 'object' || name === 'dataSchemas' || name === '_layouts') continue
    if (name === '_self') declare('', entry.data)
    else if (!name.startsWith('_')) declare(name, entry.data)
  }
  if (!declared.size) return NO_DATA_MODELS

  const refs = [...declared.values()].filter((d) => d.kind === 'schema').map((d) => d.schema)
  let resolved = {}
  if (refs.length) {
    try {
      resolved = (await resolveRecordSchemas(siteRoot, refs, { siteYml })).schemas || {}
    } catch {
      resolved = {}
    }
  }

  const models = new Map()
  for (const [where, decl] of declared) {
    if (decl.kind === 'schema') models.set(where, modelOf(resolved[decl.schema] || null, decl.schema))
    else if (decl.kind === 'fields') {
      const { kind: _kind, problems, ...schema } = decl
      let lowering = null
      const model = modelOf(schema, '@/inline', (err) => (lowering = err))
      if (problems?.length || !model) warn(where, problems?.length ? problems.join('; ') : lowering?.message || 'it lowers to no model')
      models.set(where, model)
    } else {
      // A declaration the normalizer could not take at all — a retired `'@x/y/*'` ref, a value that
      // is no shape — is a shape declared and not read, as much as a field map that fails.
      if (decl?.problems?.length) warn(where, decl.problems.join('; '))
      models.set(where, null)
    }
  }

  return (type, tag) => {
    if (!tag) return null
    if (type && models.has(at(type, tag))) return models.get(at(type, tag)) || null
    return models.get(at('', tag)) || null
  }
}

const at = (owner, key) => `${owner}\u0000${key}`

// Each unreadable shape once per site per process: extraction, the build, a push and a pull all
// read the same declarations.
const warned = new Set()

function warnUnreadable(siteRoot, where, reason, declaration) {
  const [owner, key] = where.split('\u0000')
  const once = `${siteRoot}\u0000${where}\u0000${reason}`
  if (warned.has(once)) return
  warned.add(once)
  const who = owner ? `the ${owner} section type` : 'the foundation (main.js)'
  // ⚠️ `values` only: `{ type: 'object', fields: { … } }` is the whole-schema form, read as its fields.
  const fieldsCalledType = declaration && typeof declaration === 'object' && typeof declaration.type === 'string' && 'values' in declaration && !('fields' in declaration)
  const hint = fieldsCalledType
    ? ` A data key is declared as its block's fields: { type: '${declaration.type}', values: … } declares two fields, named "type" and "values" — name the block's fields instead ({ email: 'string', time: 'string' }).`
    : /open map/.test(reason)
      ? " An open map is read when its values are records: values: { type: 'object', fields: { … } }."
      : ''
  console.warn(
    `Warning: ${who} declares data key "${key}" with a shape the translation step cannot read (${reason}), so its blocks' strings are guessed — a field named email, time, href or the like is never offered for translation.${hint}`
  )
}
