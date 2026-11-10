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

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { readFoundationName } from '../schema.js'
import { splitFoundationName } from '../foundation-name.js'
import { ownSchemaFiles, resolveSchemaRef } from '../resolve-data-schema.js'
import { resolveFoundationSrcDir } from '../utils/foundation-source-root.js'
import { canonicalJson } from '../uwx/same-content.js'
import { workspacePackages } from '../workspace-patterns.js'
import { workspaceRootOf } from '../site/workspace-extension.js'
import { classifyPackage, isSchemasPackage } from '../utils/classify-package.js'
import { librariesOf } from './libraries.js'

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

// A package's scope, read again only when its `main.js` or `package.json` changes: reading a
// foundation's name loads its `main.js`, and a dev server asks for every type it resolves.
const scopeCache = new Map()

function changedAt(dir) {
  let t = 0
  for (const f of ['package.json', 'main.js', 'src/main.js']) {
    try {
      t = Math.max(t, statSync(join(dir, f)).mtimeMs)
    } catch {
      // absent
    }
  }
  return t
}

async function cachedTypeScope(dir, kind) {
  const at = changedAt(dir)
  const hit = scopeCache.get(dir)
  if (hit && hit.at === at && hit.kind === kind) return hit.scope
  const scope = await packageTypeScope(dir, kind)
  scopeCache.set(dir, { at, kind, scope })
  return scope
}

const within = (dir, path) => {
  const rel = relative(dir, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The package `dir` is in: the nearest folder at or above it that holds a package.json. */
function packageDirOf(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) return at
    if (dirname(at) === at) return null
  }
}

/**
 * ⭐ A TYPE ANOTHER PACKAGE OF THE WORKSPACE, OR A LIBRARY THE ASKING PACKAGE BUNDLES, DEFINES,
 * found with nothing configured. Foundations a team develops together share a type by its full
 * name, `@acme/member`, and a local build reads it from the package that defines it: a foundation
 * whose name gives the `@acme` scope and whose own `schemas/` holds `member`, or a schemas package
 * of that scope. No `schemas.config.js`, no package to install, nothing registered: sharing a type
 * never needs a backend *[Diego, 2026-11-08: "it should be easy and good DX to share schemas"]*.
 *
 * Two kinds of package are read, each one the asker's to read:
 *   - the workspace's packages, as pnpm reads its list (`../workspace-patterns.js`), when `fromDir`
 *     is in one of them, so a copy kept outside the list, a backup folder say, is never read;
 *   - each library the asking package bundles (`librariesOf`), wherever it is: in another
 *     repository beside the workspace, say, linked with `file:` or `link:`. A library is such a
 *     schemas package when it gives its scope in its `package.json` (`uniweb.scope`) and holds
 *     `schemas/`. ⛔ Until 2026-11-09 only the workspace's were, and a library outside it needed
 *     `schemas.config.js` in every foundation that named its types.
 * Found by the same rule `typesDefinedTwice` names copies by.
 *
 * @param {string} ref - `@scope/name`
 * @param {string} fromDir - the foundation (its source folder) or site asking
 * @returns {Promise<string[]>} the files that define it, each once; the caller refuses more than one
 */
export async function workspaceTypeFiles(ref, fromDir) {
  const m = /^(@[^/]+)\/(.+)$/.exec(ref || '')
  if (!m) return []
  const [, scope, name] = m
  const candidates = []
  const root = workspaceRootOf(fromDir)
  if (root) {
    const packages = workspacePackages(root).map((rel) => join(root, rel))
    if (packages.some((dir) => within(dir, resolve(fromDir)))) candidates.push(...packages)
  }
  const asking = packageDirOf(fromDir)
  if (asking) candidates.push(...librariesOf(asking).map((lib) => lib.dir))
  const files = new Map()
  const seen = new Set()
  for (const dir of candidates) {
    const at = real(dir)
    if (seen.has(at)) continue
    seen.add(at)
    const kind = classifyPackage(dir) === 'foundation' ? 'foundation' : isSchemasPackage(dir) ? 'schemas' : null
    if (!kind) continue
    if ((await cachedTypeScope(dir, kind)) !== scope) continue
    const typesAt = typeRoot(dir, kind)
    if (!existsSync(join(typesAt, 'schemas'))) continue
    for (const own of ownSchemaFiles(typesAt)) {
      if (own.name === name) files.set(real(own.file), own.file)
    }
  }
  return [...files.values()]
}
