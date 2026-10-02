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
    for (const [key, decl] of Object.entries(normalized || {})) declared.set(at(owner, key), decl)
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
      const { kind: _kind, problems: _problems, ...schema } = decl
      models.set(where, modelOf(schema, '@/inline'))
    } else models.set(where, null)
  }

  return (type, tag) => {
    if (!tag) return null
    if (type && models.has(at(type, tag))) return models.get(at(type, tag)) || null
    return models.get(at('', tag)) || null
  }
}

const at = (owner, key) => `${owner}\u0000${key}`
