/**
 * ⭐ A DATA SCHEMA IS USABLE BY ANY FOUNDATION OR SITE, by its full name — `@acme/member`: locally,
 * through `schemas.config.js` or a shared `@acme/schemas` package, with no backend, and from a backend
 * once it is registered, which is optional. Its scope is a namespace, so that names never collide, and
 * says who may publish under it, never who may use it *[Diego, 2026-09-25; 2026-11-08]*. A foundation
 * that renders another's type declares it by that name, and a register names it and sends no
 * definition of it (`uwx/registry-package.js`).
 *
 * So a copy of a type's file in a second package of the same scope is a second definition of one type,
 * and the copies come apart the first time one is edited. `typesDefinedTwice` names each such type, for
 * `uniweb doctor` to recommend one definition, named in full elsewhere, with `schemas.config.js`
 * giving a local build the file (`resolve-data-schema.js`). It refuses nothing: what a register of a
 * changed definition does is the registry's to judge.
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
 * A package whose name gives no scope yet is left out: until `register` writes one into its name, its
 * types have no full name to compare.
 *
 * @param {{ dir: string, kind: 'foundation'|'schemas' }[]} packages - the workspace's foundations and
 *   schemas packages
 * @returns {Promise<{ ref: string, files: string[], differ: boolean }[]>} by name
 */
export async function typesDefinedTwice(packages) {
  const byRef = new Map()
  const seen = new Set()
  for (const pkg of packages) {
    const dir = real(pkg.dir)
    if (seen.has(dir)) continue
    seen.add(dir)
    const scope = await packageTypeScope(dir, pkg.kind)
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
