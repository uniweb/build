/**
 * ⭐ ONE NAME IN A SCOPE IS ONE TYPE. A data schema registers by its name alone — `@acme/member`, its
 * scope and its name — and a registry holds one type under each. A register whose declaration of it
 * differs from the one held makes a new version of that type, which every site using it then reads.
 * So two packages of one scope in a workspace that each define `member` — two foundations, or a
 * foundation and the scope's schemas package — are two definitions of one type, and whichever
 * registers last decides what it is for the other's sites too. Copies that agree today come apart the
 * first time one is edited.
 *
 * A type several foundations of a scope use is defined once — in the scope's schemas package, or in
 * the one foundation that owns it — and every other foundation names it in full (`@acme/member`), with
 * `schemas.config.js` routing the scope to the folder that holds it (`resolve-data-schema.js`). A full
 * name is a reference, which a register names and does not send (`uwx/registry-package.js`).
 *
 * `uniweb register` refuses a definition that differs from another of the same name in the workspace,
 * since that is when a register changes what another foundation's sites read; `uniweb doctor` names
 * every name defined twice, agreeing or not.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readFoundationName } from '../schema.js'
import { splitFoundationName } from '../foundation-name.js'
import { ownSchemaFiles, resolveSchemaRef } from '../resolve-data-schema.js'
import { resolveFoundationSrcDir } from '../utils/foundation-source-root.js'
import { canonicalJson } from '../uwx/same-content.js'

const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** `acme`, `@acme` or `@acme/x` → `@acme`; anything else → null. */
function asScope(value) {
  const handle = typeof value === 'string' ? value.trim().replace(/^@/, '').replace(/\/.*$/, '') : ''
  return handle ? `@${handle}` : null
}

/**
 * The scope a package's types register under, where it already says one: a foundation's is the one in
 * its name (`main.js`), a schemas package's its `package.json`'s `uniweb.scope`, else the `@org` of a
 * package named `@org/schemas`. Null for a name with no scope yet, which `register` settles first.
 *
 * @param {string} dir - the package's folder
 * @param {'foundation'|'schemas'} kind
 * @returns {Promise<string|null>}
 */
export async function packageTypeScope(dir, kind) {
  if (kind === 'foundation') {
    try {
      const { name } = await readFoundationName(dir)
      return splitFoundationName(name).scope || null
    } catch {
      return null
    }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const named = /^@([^/]+)\/schemas$/.exec(typeof pkg?.name === 'string' ? pkg.name : '')
    return asScope(pkg?.uniweb?.scope) || (named ? `@${named[1]}` : null)
  } catch {
    return null
  }
}

// The folder a package's `schemas/` is in: a foundation's source root, a schemas package's own.
function typeRoot(dir, kind) {
  return kind === 'foundation' ? join(dir, resolveFoundationSrcDir(dir)) : dir
}

/**
 * Each name of a scope that two or more of the packages define, with the files that define it and
 * whether they say the same thing.
 *
 * @param {{ dir: string, kind: 'foundation'|'schemas', scope?: string|null }[]} packages - the
 *   workspace's foundations and schemas packages; a `scope` given is used over what the package says
 *   (a name `register` has just settled)
 * @returns {Promise<{ ref: string, files: string[], differ: boolean }[]>} by name
 */
export async function typesDefinedTwice(packages) {
  const byRef = new Map()
  const seen = new Set()
  for (const pkg of packages) {
    const dir = real(pkg.dir)
    if (seen.has(dir)) continue
    seen.add(dir)
    const scope = asScope(pkg.scope) || (await packageTypeScope(dir, pkg.kind))
    if (!scope) continue
    const root = typeRoot(dir, pkg.kind)
    if (!existsSync(join(root, 'schemas'))) continue
    for (const { name, file } of ownSchemaFiles(root)) {
      const ref = `${scope}/${name}`
      if (!byRef.has(ref)) byRef.set(ref, [])
      byRef.get(ref).push({ root, name, file })
    }
  }
  const out = []
  for (const [ref, defs] of [...byRef].sort(([a], [b]) => a.localeCompare(b))) {
    if (defs.length < 2) continue
    const said = new Set()
    for (const { root, name, file } of defs) {
      try {
        said.add(canonicalJson(await resolveSchemaRef(`@/${name}`, { srcDir: root, aliases: {} })))
      } catch {
        // One that does not read is not the same as one that does.
        said.add(`unreadable:${file}`)
      }
    }
    out.push({ ref, files: defs.map((d) => d.file), differ: said.size > 1 })
  }
  return out
}
