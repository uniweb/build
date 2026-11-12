/**
 * ⭐ A LIBRARY'S COMPUTE FILES, CARRIED BY A FOUNDATION THAT NAMES THEM — as a library's mappings are
 * (`library-mappings.js`). A library may hold `compute/` beside its `schemas/` and `mappings/`, under
 * its scope, and a foundation carries one by naming it in full in its `main.js`:
 *
 * ```js
 * export default {
 *   name: '@shop/storefront',
 *   compute: ['@acme/grading'],
 * }
 * ```
 *
 * The build reads each from the library that defines it (`workspaceComputeFiles`), checks it as a
 * foundation's own is checked, and keeps its exports in `_compute` under its full name. `register`
 * names it in the foundation's vendor refs, and registers and uploads it from the library first.
 *
 * A name no package here defines only warns: it may be registered already, and the registry judges.
 *
 * @module
 */

import { basename } from 'node:path'
import { parseSchemaRef } from '@uniweb/schemas/format'
import { workspaceComputeFiles } from './shared-types.js'
import { COMPUTE_DIR, readComputeFile } from './compute.js'

/**
 * The library compute files a foundation's `main.js` names.
 *
 * @param {*} names - `main.js`'s `compute:`, as written
 * @param {object} p
 * @param {string} p.srcDir - the foundation's source root
 * @param {string|null} p.ownScope - the foundation's scope, when its name gives one
 * @returns {Promise<{ map: Object<string, { exports: string[] }|null>, warnings: string[] }>}
 *   `map`: full name → its exports, or null when no package here defines it
 * @throws {Error} naming each one that cannot be carried, and why
 */
export async function resolveLibraryCompute(names, { srcDir, ownScope = null }) {
  if (names === undefined) return { map: {}, warnings: [] }
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw new Error(
      "[uniweb] main.js: `compute` lists the library compute files the foundation carries, each named in full — `compute: ['@acme/grading']`."
    )
  }
  const map = {}
  const warnings = []
  const found = []
  for (const name of names) {
    const at = `main.js: \`compute\` names \`${name}\``
    let scope
    try {
      ;({ scope } = parseSchemaRef(name))
    } catch {
      found.push(`${at}, which is not a compute file's full name, \`'@scope/<name>'\`.`)
      continue
    }
    if (!scope || name.startsWith('@/')) {
      found.push(`${at}: a compute file of the foundation's own is a file in src/${COMPUTE_DIR}/, and is not listed. List a library's, in full.`)
      continue
    }
    if (ownScope && `@${String(ownScope).replace(/^@/, '')}` === `@${scope}`) {
      found.push(`${at}, in the foundation's own scope: a compute file of its own is a file in src/${COMPUTE_DIR}/.`)
      continue
    }
    const files = await workspaceComputeFiles(name, srcDir)
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
    const shown = `${COMPUTE_DIR}/${basename(files[0])} (for ${name})`
    const { exports, problems, warnings: w } = await readComputeFile(files[0])
    if (problems.length) {
      found.push(...problems.map((p) => `${shown} ${p}`))
      continue
    }
    warnings.push(...w.map((x) => `${shown}: ${x}`))
    map[name] = { exports }
  }
  if (found.length) {
    throw new Error(
      found.length === 1
        ? `[uniweb] ${found[0]}`
        : `[uniweb] library compute files the foundation cannot carry:\n${found.map((f) => `  - ${f}`).join('\n')}`
    )
  }
  return { map, warnings }
}
