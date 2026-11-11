/**
 * ⭐ A LIBRARY'S MAPPINGS, CARRIED BY A FOUNDATION THAT NAMES THEM. A library (one back office, many
 * front desks) may hold `mappings/` beside its `schemas/`, under its scope. A foundation carries one
 * by naming it in full in its `main.js`:
 *
 * ```js
 * export default {
 *   name: '@shop/storefront',
 *   mappings: ['@acme/vehicle-to-meta'],
 * }
 * ```
 *
 * The build reads each from the library that defines it (`workspaceMappingFiles`, the rule a
 * library's types are found by), checks it as a foundation's own mapping is checked, against the
 * library's types and mappings, and keeps it in `_mappings` under its full name, with every name in
 * it in full. `register` names it in the foundation's `mappings` refs, and registers it from the
 * library first.
 *
 * A name no package here defines only warns: it may be registered already, and the registry judges.
 *
 * @module
 */

import { basename, dirname } from 'node:path'
import { parseSchemaRef } from '@uniweb/schemas/format'
import { qualifyRef } from '@uniweb/schemas/refs'
import { ownSchemaRefs } from '../resolve-data-schema.js'
import { workspaceMappingFiles } from './shared-types.js'
import { MAPPINGS_DIR, loadMappingFile, mappingInFull, mappingProblems, ownMappingFiles } from './mappings.js'

/**
 * The library mappings a foundation's `main.js` names.
 *
 * @param {*} names - `main.js`'s `mappings:`, as written
 * @param {object} p
 * @param {string} p.srcDir - the foundation's source root
 * @param {string|null} p.ownScope - the foundation's scope, when its name gives one
 * @returns {Promise<{ map: Object<string, object|null>, warnings: string[] }>} `map`: full name →
 *   the mapping with its names in full, or null when no package here defines it
 * @throws {Error} naming each one that cannot be carried, and why
 */
export async function resolveLibraryMappings(names, { srcDir, ownScope = null }) {
  if (names === undefined) return { map: {}, warnings: [] }
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw new Error(
      "[uniweb] main.js: `mappings` lists the library mappings the foundation carries, each named in full — `mappings: ['@acme/vehicle-to-meta']`."
    )
  }
  const map = {}
  const warnings = []
  const found = []
  for (const name of names) {
    const at = `main.js: \`mappings\` names \`${name}\``
    let scope
    try {
      ;({ scope } = parseSchemaRef(name))
    } catch {
      found.push(`${at}, which is not a mapping's full name, \`'@scope/<name>'\`.`)
      continue
    }
    if (!scope || name.startsWith('@/')) {
      found.push(`${at}: a mapping of the foundation's own is a file in src/${MAPPINGS_DIR}/, and is not listed. List a library's, in full.`)
      continue
    }
    if (ownScope && `@${String(ownScope).replace(/^@/, '')}` === `@${scope}`) {
      found.push(`${at}, in the foundation's own scope: a mapping of its own is a file in src/${MAPPINGS_DIR}/.`)
      continue
    }
    const files = await workspaceMappingFiles(name, srcDir)
    if (files.length > 1) {
      found.push(`${at}, which ${files.length} packages define: ${files.join(', ')}. Keep one.`)
      continue
    }
    if (!files.length) {
      warnings.push(
        `${at}, which no package here defines, so the build can't check it. \`uniweb register\` names it, and the registry refuses the foundation unless it is registered under @${scope}.`
      )
      map[name] = null
      continue
    }
    const file = files[0]
    const root = dirname(dirname(file))
    const shown = `${MAPPINGS_DIR}/${basename(file)} (for ${name})`
    let decl
    try {
      decl = await loadMappingFile(file)
    } catch (err) {
      found.push(`${shown}: ${String(err?.message || err).split('\n')[0]}`)
      continue
    }
    const problems = mappingProblems(decl, {
      types: new Set(ownSchemaRefs(root)),
      names: new Set(ownMappingFiles(root).map((m) => `@/${m.name}`)),
    })
    if (problems.length) {
      found.push(...problems.map((p) => `${shown}: ${p}`))
      continue
    }
    map[name] = mappingInFull(decl, (ref) => qualifyRef(ref, scope))
  }
  if (found.length) {
    throw new Error(
      found.length === 1
        ? `[uniweb] ${found[0]}`
        : `[uniweb] library mappings the foundation cannot carry:\n${found.map((f) => `  - ${f}`).join('\n')}`
    )
  }
  return { map, warnings }
}
