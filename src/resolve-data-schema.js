/**
 * Data-schema reference resolver + validator (build time)
 *
 * Resolves a foundation's data-schema refs to validated, normalized schema
 * objects on disk, and validates the schema definition format so a developer
 * gets a clear error at build time, not after publish. Refs are a Uniweb
 * namespacing concept — NOT Node module resolution, nothing fetched:
 *
 *   '@/name'         → this foundation's own namespace:
 *                      <srcDir>/schemas/name.{js,json,yml,yaml}
 *   '@std/name'      → the shared standard schemas, shipped in the framework's
 *                      `@uniweb/schemas` package (resolved from the FOUNDATION's
 *                      node_modules)
 *   '@org/name'      → an org's own schemas, resolved from that org's
 *                      `@org/schemas` package — define schemas once and share
 *                      them across foundations, locally, no backend. (The org
 *                      becomes a real registry scope at publish time.)
 *   '@uniweb/name'   → reserved: the platform system namespace, not a data
 *                      schema source (rejected, with a pointer to '@std').
 *
 * Alias routing (`schemas.config.js`): a foundation may route a scope to a
 * directory of schema files ('@org' → a folder), so '@org/name' resolves to a
 * bare folder anywhere on disk — no package, no install. It may also override a
 * SINGLE schema to an exact file ('@org/name' → a file), which wins over the
 * scope directory for that one name. Both take precedence over the '@org/schemas'
 * package convention (file over directory over package); see `loadSchemaAliases`.
 *
 * The authoring format itself — the type vocabulary and the normalization of its
 * friendly aliases to canonical kinds — lives in `@uniweb/schemas/format`, and is
 * re-exported below so every existing import of this module keeps working. It was
 * moved there because it is a contract with more than one consumer (this build,
 * the `@uniweb/schemas` package's own `validate()`, and any tooling that reads a
 * schema), and a reader that cannot reach it grows a second copy that drifts —
 * which is exactly what had happened. This module keeps the half that needs a
 * disk: finding a ref's file, alias routing, and closing the resolution graph.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, isAbsolute, extname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'

import {
  SCHEMA_EXTENSIONS,
  parseSchemaRef,
  validateAndNormalizeSchema,
  collectNestedRefs,
} from '@uniweb/schemas/format'

// The authoring format, re-exported so this module stays the build's single
// entry point for schema resolution + normalization (no call site moved when the
// format itself did).
export {
  SCALAR_KINDS,
  STRUCTURAL_KINDS,
  FORMAT_TYPES,
  SECTION_KINDS,
  AUTHORING_TYPES,
  SCHEMA_EXTENSIONS,
  parseSchemaRef,
  validateAndNormalizeSchema,
  collectNestedRefs,
} from '@uniweb/schemas/format'

// Scope → schema package resolution. The shared standard schemas are referenced
// under '@std' but ship in the framework's '@uniweb/schemas' package; every
// other '@org' maps by convention to that org's own '@org/schemas' package, so a
// team can define org-scoped schemas once (a workspace package) and share them
// across foundations — locally, with no backend. '@uniweb' is reserved for the
// platform system namespace and is never a data-schema source.
const SCOPE_PACKAGE = { std: '@uniweb/schemas' }
const RESERVED_SYSTEM_SCOPE = 'uniweb'
const packageForScope = (scope) => SCOPE_PACKAGE[scope] ?? `@${scope}/schemas`

/**
 * Collect every distinct schema ref used by a foundation's section bindings.
 * Reads `data: { key: '<ref>' }` (short) and `data: { key: { schema: '<ref>' } }`
 * (full). Non-string / schemaless entries are ignored.
 *
 * @param {Object} components - Map of componentName → full meta (with `data`)
 * @returns {Set<string>}
 */
export function collectSchemaRefs(components) {
  const refs = new Set()
  for (const meta of Object.values(components || {})) {
    const data = meta?.data
    if (!data || typeof data !== 'object' || data === false) continue
    for (const binding of Object.values(data)) {
      const ref = typeof binding === 'string' ? binding : binding?.schema
      if (typeof ref === 'string') refs.add(ref)
    }
  }
  return refs
}

/**
 * Resolve one ref to its validated, normalized schema object.
 *
 * @param {string} ref
 * @param {{ srcDir: string }} ctx - Foundation source root
 * @returns {Promise<Object>} normalized schema
 */
export async function resolveSchemaRef(ref, { srcDir, aliases }) {
  const { scope, name } = parseSchemaRef(ref)

  if (scope === '') {
    const file = findSelfSchemaFile(srcDir, name)
    if (!file) {
      const tried = SCHEMA_EXTENSIONS.map((e) => `schemas/${name}${e}`).join(', ')
      throw new Error(`Data schema '${ref}' not found. Expected one of: ${tried} under the foundation root.`)
    }
    return validateAndNormalizeSchema(await loadSchemaFile(file), ref)
  }

  if (scope === RESERVED_SYSTEM_SCOPE) {
    throw new Error(
      `'@${scope}' is the reserved platform system namespace and is not a data-schema source. ` +
        `Use '@std/${name}' for the shared standard schemas.`
    )
  }

  // Alias routing (schemas.config.js), most-specific first — no package, no
  // install, no node_modules; '@/' (self) and the reserved '@uniweb' scope are
  // handled above and are never aliasable.
  //
  // A per-schema alias ('@org/name' → a FILE) overrides one schema to an exact
  // file. It's the explicit way to keep a shared scope routed to a catalog while
  // swapping in one local definition — no symlink, no forked scope. It wins over
  // the scope directory (checked next), which wins over the package (below).
  const aliasedFile = aliases?.[`@${scope}/${name}`]
  if (aliasedFile) {
    const file = resolveAliasedSchemaFile(aliasedFile)
    if (!file) {
      throw new Error(
        `Data schema '${ref}' is aliased to '${aliasedFile}' (via schemas.config.js), but no schema file ` +
          `exists there. Point it at a ${SCHEMA_EXTENSIONS.join(' / ')} file.`
      )
    }
    return validateAndNormalizeSchema(await loadSchemaFile(file), ref)
  }

  // A scope alias ('@org' → a DIR) resolves 'name' to a bare schema FILE in that
  // directory. This lets a foundation point '@agency' at a shared schema folder
  // anywhere on disk.
  const aliasDir = aliases?.[`@${scope}`]
  if (aliasDir) {
    const file = findSchemaFileInDir(aliasDir, name)
    if (!file) {
      const tried = SCHEMA_EXTENSIONS.map((e) => `${name}${e}`).join(', ')
      let msg =
        `Data schema '${ref}' not found in the directory '@${scope}' is aliased to ('${aliasDir}' ` +
        `via schemas.config.js). Expected one of: ${tried}.`
      // The confusing case: the '@org/schemas' package is ALSO installed. A routed
      // scope never falls back to it (fail-loud beats silently loading a different
      // definition), so say so rather than leave the developer wondering.
      if (isScopePackageInstalled(scope, srcDir)) {
        msg +=
          ` Note: '${packageForScope(scope)}' is installed, but a routed scope takes precedence over the ` +
          `package and does not fall back to it. Override this one schema with a '@${scope}/${name}' file alias, ` +
          `or add '${name}' to the routed directory.`
      }
      throw new Error(msg)
    }
    return validateAndNormalizeSchema(await loadSchemaFile(file), ref)
  }

  // Every other scope is an org namespace: '@org/name' resolves `name` from that
  // org's '@org/schemas' package (the standards live under '@std', which ships in
  // '@uniweb/schemas'). Resolved from the foundation's node_modules, so a
  // workspace package shared across foundations works locally with no backend.
  const pkg = packageForScope(scope)
  const schema = await resolveScopedSchema(pkg, name, srcDir)
  if (!schema) {
    throw new Error(`Unknown data schema '${ref}': '${pkg}' exports no schema named '${name}'.`)
  }
  return validateAndNormalizeSchema(schema, ref)
}

/**
 * Resolve every ref to its normalized schema, keyed by ref verbatim, CLOSED
 * under references: a schema's nested `ref`/`options` targets are resolved too
 * (transitively, cycle-guarded), so the published map carries the whole graph.
 * An unresolvable target throws — naming it (publish guarantee: references
 * always resolve).
 *
 * @param {Iterable<string>} refs
 * @param {{ srcDir: string }} ctx
 * @returns {Promise<Object>} `{ [ref]: normalizedSchema }`
 */
export async function buildDataSchemaMap(refs, { srcDir }) {
  // Load the foundation's optional schemas.config.js once; every ref (and every
  // transitively-discovered ref) resolves against the same alias map. This is
  // the single entry both schema discovery and the runtime-schema build go
  // through, so editor schema.json, runtime defaults, and `uniweb validate` all
  // resolve refs identically.
  const aliases = await loadSchemaAliases(srcDir)
  const map = {}
  const queue = Array.from(refs)
  while (queue.length > 0) {
    const ref = queue.shift()
    if (map[ref]) continue
    map[ref] = await resolveSchemaRef(ref, { srcDir, aliases })
    for (const target of collectNestedRefs(map[ref])) {
      if (!map[target]) queue.push(target)
    }
  }
  return map
}

/**
 * Collect every data schema a STANDALONE schemas package defines, normalized and
 * keyed by self-ref (`@/<name>`) — the input to a foundation-less registry
 * publish (buildSchemaOnlyPackage). A schemas package exposes its schemas one of
 * two ways, tried in order:
 *
 *   1. Module exports — the package entry exports `getSchemaNames()` + `getSchema()`
 *      (or a `schemas` map / a default map). This is the same `@org/schemas`
 *      package contract that foundations already consume through `@std/x` /
 *      `@org/x` refs (`resolveScopedSchema` below), so a package registers exactly
 *      the schemas it offers consumers (e.g. `@uniweb/schemas` → the standards).
 *   2. A `schemas/` directory of `*.{js,json,yml,yaml}` files — one schema per
 *      file, named by basename. For a bare folder of schema files with no index.
 *
 * Names only, no uuids; normalization only (no lowering to any storage model).
 * Each schema is validated, so a malformed one throws a clear error before publish.
 *
 * @param {string} packageDir - the schemas package root.
 * @returns {Promise<Record<string, object>>} `{ '@/<name>': normalizedSchema }`
 */
export async function collectStandaloneSchemas(packageDir) {
  const fromExports = await collectSchemasFromExports(packageDir)
  if (Object.keys(fromExports).length > 0) return fromExports
  return collectSchemasFromDir(join(packageDir, 'schemas'))
}

// Source 1: a package whose entry exports schemas. Mirrors how a foundation
// consumes an `@org/schemas` package (getSchema / schemas / default), plus
// `getSchemaNames()` for enumeration. Returns `{}` when the package exports none.
async function collectSchemasFromExports(packageDir) {
  const pkgPath = join(packageDir, 'package.json')
  if (!existsSync(pkgPath)) return {}
  let pkg
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  } catch {
    return {}
  }
  const entry = resolvePackageEntryFile(packageDir, pkg)
  if (!entry || !existsSync(entry)) return {}

  let mod
  try {
    mod = await import(pathToFileURL(entry).href)
  } catch (err) {
    throw new Error(`Could not load the schemas package entry (${entry}): ${err.message}`)
  }
  const names =
    typeof mod.getSchemaNames === 'function'
      ? mod.getSchemaNames()
      : Object.keys(mod.schemas ?? mod.default ?? {})
  const get = (name) =>
    typeof mod.getSchema === 'function' ? mod.getSchema(name) : (mod.schemas?.[name] ?? mod.default?.[name])

  const out = {}
  for (const name of names) {
    const schema = get(name)
    if (!schema || typeof schema !== 'object') continue
    out[`@/${name}`] = validateAndNormalizeSchema(schema, `@/${name}`)
  }
  return out
}

// Source 2: a bare `schemas/` directory of schema files, one schema per file
// (named by basename). Returns `{}` when the directory is absent.
async function collectSchemasFromDir(dir) {
  if (!existsSync(dir)) return {}
  const out = {}
  for (const file of readdirSync(dir).sort()) {
    const ext = extname(file)
    if (!SCHEMA_EXTENSIONS.includes(ext)) continue
    const name = basename(file, ext)
    out[`@/${name}`] = validateAndNormalizeSchema(await loadSchemaFile(join(dir, file)), `@/${name}`)
  }
  return out
}

// Resolve a package's module entry FILE (absolute) from its package.json —
// `exports['.']` (string or a conditional import/default/node), else `main`, else
// `index.js`. Loads a schemas package's own exports without self-resolution.
function resolvePackageEntryFile(packageDir, pkg) {
  let entry = typeof pkg.main === 'string' ? pkg.main : null
  const exp = pkg.exports
  if (exp) {
    const dot = typeof exp === 'string' ? exp : (exp['.'] ?? exp['./index'])
    const e = typeof dot === 'string' ? dot : (dot?.import ?? dot?.default ?? dot?.node)
    if (typeof e === 'string') entry = e
  }
  return join(packageDir, entry || 'index.js')
}

// --- internals --------------------------------------------------------------

function findSelfSchemaFile(srcDir, name) {
  return findSchemaFileInDir(join(srcDir, 'schemas'), name)
}

// Find a schema file named `name` (any supported extension) directly inside a
// directory. Used for both '@/' self-schemas (in <srcDir>/schemas) and aliased
// scopes (in the directory schemas.config.js maps the scope to).
function findSchemaFileInDir(dir, name) {
  for (const ext of SCHEMA_EXTENSIONS) {
    const candidate = join(dir, name + ext)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Load a foundation's optional `schemas.config.js` and return a map of
 * `'@key' → absolute path`. The file default-exports a plain object; each key is
 * either a SCOPE (routing the whole scope to a directory of schema files) or a
 * single SCHEMA (`@scope/name`, overriding that one schema to an exact file):
 *
 *   // <foundation>/schemas.config.js
 *   export default {
 *     '@agency':        '../shared/agency-schemas',   // scope → directory
 *     '@agency/person': './schemas/agency-person.yml', // one schema → a file
 *     '@brand':         process.env.BRAND_SCHEMAS,     // machine-specific, via env
 *   }
 *
 * It's plain JS (consistent with main.js / vite.config.js), so paths compute
 * natively — relative, absolute, env-based, or homedir — with no expansion DSL.
 * Relative paths resolve against the foundation source dir. A key whose value is
 * null/undefined (e.g. an unset env var) is skipped — that scope/schema falls
 * back to the next source (scope directory, then the '@org/schemas' package).
 * Returns `{}` when the file is absent.
 *
 * @param {string} srcDir - Foundation source root (where main.js lives).
 * @returns {Promise<Record<string, string>>}
 */
async function loadSchemaAliases(srcDir) {
  const file = join(srcDir, 'schemas.config.js')
  if (!existsSync(file)) return {}

  let raw
  try {
    const mod = await import(pathToFileURL(file).href)
    raw = mod.default
  } catch (err) {
    throw new Error(`Failed to load schemas.config.js: ${err.message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`schemas.config.js must default-export a map of '@scope' (or '@scope/name') → path.`)
  }

  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue // unset (e.g. missing env var) → not aliased
    if (typeof value !== 'string') {
      throw new Error(`schemas.config.js: alias '${key}' must be a path string, got ${typeof value}.`)
    }
    validateAliasKey(key)
    out[key] = isAbsolute(value) ? value : resolve(srcDir, value)
  }
  return out
}

// A schemas.config.js key is either a scope ('@agency' → a directory of schema
// files) or a single schema ('@agency/person' → one file). Reject '@/' (self —
// put the file in the foundation's schemas/), the reserved '@uniweb' scope, and
// anything malformed. The message keeps the "must be a scope like '@agency'"
// phrasing so the guidance reads the same for the common no-'@' slip.
function validateAliasKey(key) {
  if (typeof key !== 'string' || key[0] !== '@') {
    throw new Error(
      `schemas.config.js: alias key '${key}' must be a scope like '@agency' (or a single schema like '@agency/person').`
    )
  }
  const slash = key.indexOf('/')
  const scope = slash === -1 ? key.slice(1) : key.slice(1, slash)
  const name = slash === -1 ? '' : key.slice(slash + 1)
  if (!scope) {
    throw new Error(`schemas.config.js: alias key '${key}' must be a scope like '@agency' (not '@/…' — that's the foundation's own schemas/).`)
  }
  if (scope === RESERVED_SYSTEM_SCOPE) {
    throw new Error(`schemas.config.js: '@${scope}' is reserved and cannot be aliased. Use '@std' for the standard schemas.`)
  }
  if (slash !== -1 && (!name || name.includes('/'))) {
    throw new Error(`schemas.config.js: alias key '${key}' must be '@scope' or '@scope/name' (a single schema name).`)
  }
}

// Resolve a per-schema alias VALUE (already an absolute path) to a loadable
// schema file: the exact path if it names a file, else the path + each known
// extension (so a '@acme/person' → '.../person' value finds 'person.yml'). A
// directory is not a file — returns null so the caller errors clearly.
function resolveAliasedSchemaFile(absPath) {
  if (existsSync(absPath) && !statSync(absPath).isDirectory()) return absPath
  for (const ext of SCHEMA_EXTENSIONS) {
    if (existsSync(absPath + ext)) return absPath + ext
  }
  return null
}

// Is the scope's '@org/schemas' package resolvable from the foundation? Used only
// to enrich a routed-scope "not found" error — never throws, never loads.
function isScopePackageInstalled(scope, srcDir) {
  try {
    createRequire(join(srcDir, 'package.json')).resolve(packageForScope(scope))
    return true
  } catch {
    return false
  }
}

async function loadSchemaFile(filePath) {
  if (filePath.endsWith('.js')) {
    const mod = await import(pathToFileURL(filePath).href)
    return mod.default
  }
  const text = await readFile(filePath, 'utf8')
  if (filePath.endsWith('.json')) return JSON.parse(text)
  return yaml.load(text) // .yml / .yaml
}

/**
 * Load a scope's schema package and pull the named schema.
 *
 * The FOUNDATION's context is the primary resolution and stays that way: it is
 * what lets each foundation pin its own version of a shared schema package. An
 * `@org/schemas` is genuinely third-party — we cannot know it exists — so a
 * foundation that references one must declare it.
 *
 * ⭐ `@std` IS THE ONE EXCEPTION, BECAUSE IT IS OURS. It ships in
 * `@uniweb/schemas`, a framework package `@uniweb/build` already depends on and
 * imports directly (the `@uniweb/schemas/format` import at the top of this
 * file). Requiring a foundation author to install a package the tool doing the
 * resolution is already carrying is a requirement with nothing behind it, so
 * when the foundation has no copy we fall back to ours.
 *
 * ⚠️ A FALLBACK, NOT A REDIRECT. A foundation that installs `@uniweb/schemas`
 * still gets its own — pinning and vendoring keep working — and `@org`
 * behaviour does not change at all.
 *
 * ⛔ AND IT THROWS RATHER THAN DEGRADING. Neighbouring code soft-skips a schema
 * it cannot resolve (a collection falls back to delivery-only), which is right
 * for "the author never asked for one" and wrong here: a `@std/` ref IS the
 * asking. Answering it with silence would turn a missing package into a schema
 * that merely appears not to exist.
 */
async function resolveScopedSchema(pkg, name, srcDir) {
  const req = createRequire(join(srcDir, 'package.json'))
  let entry
  try {
    entry = req.resolve(pkg)
  } catch {
    if (pkg === SCOPE_PACKAGE.std) return readNamedSchema(await loadOwnStandardSchemas(pkg), name)
    throw new Error(
      `'${pkg}' is not installed in this foundation, but a schema ref needs it. ` +
        `Add '${pkg}' to the foundation's devDependencies to resolve those refs ` +
        `(it is needed to BUILD the foundation; nothing it provides reaches the bundle).`
    )
  }
  return readNamedSchema(await import(pathToFileURL(entry).href), name)
}

/** Pull one named schema out of a loaded schemas package. */
function readNamedSchema(mod, name) {
  if (typeof mod.getSchema === 'function') return mod.getSchema(name)
  return mod.schemas?.[name] ?? mod.default?.[name]
}

/**
 * The build's own copy of the standard schemas — the `@std` fallback above.
 *
 * Imported by bare specifier so it resolves from THIS module's context, i.e.
 * `@uniweb/build`'s own dependency rather than the foundation's. It cannot
 * realistically be missing: this file statically imports `@uniweb/schemas/format`,
 * so the module would not have loaded. Throwing anyway, with the reason, beats
 * returning undefined and having the caller report it as "exports no schema
 * named X" — which would name the wrong problem.
 */
async function loadOwnStandardSchemas(pkg) {
  try {
    return await import('@uniweb/schemas')
  } catch (err) {
    throw new Error(
      `'${pkg}' is not installed in this foundation, and @uniweb/build's own copy could not ` +
        `be loaded either (${err.message}). Reinstall @uniweb/build; if the install omitted ` +
        `optional or otherwise-skippable packages, run it again without that flag.`
    )
  }
}
