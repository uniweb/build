/**
 * Data-schema reference resolver (build time)
 *
 * Resolves a foundation's data-schema refs to canonical schema objects on disk.
 * Refs are a Uniweb namespacing concept — NOT Node module resolution, no
 * package.json export maps, nothing fetched:
 *
 *   '@/name'         → this foundation's own namespace:
 *                      <srcDir>/schemas/name.{js,json,yml,yaml}
 *   '@uniweb/name'   → the shared standards namespace: the schema named `name`
 *                      from the `@uniweb/schemas` package, resolved from the
 *                      FOUNDATION's node_modules (the package name is hidden —
 *                      the ref names the namespace, not the package)
 *   '@scope/name'    → another publisher's namespace (not exercised this pass)
 *
 * A canonical schema is `{ name, version?, description?, fields: { ... } }` —
 * the `@uniweb/schemas` rich shape. `name`/`version` are identity only; they
 * are never used as runtime delivery keys (see
 * kb/framework/plans/named-data-schemas.md).
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'

// Extensions a foundation-local schema file may use, in resolution order.
const SCHEMA_EXTENSIONS = ['.js', '.json', '.yml', '.yaml']

/**
 * Parse a data-schema ref into `{ scope, name }`.
 *   '@/member'       → { scope: '',       name: 'member' }   (self namespace)
 *   '@uniweb/person' → { scope: 'uniweb', name: 'person' }
 *
 * @param {string} ref
 * @returns {{ scope: string, name: string }}
 * @throws on a malformed ref
 */
export function parseSchemaRef(ref) {
  if (typeof ref !== 'string' || ref[0] !== '@') {
    throw new Error(
      `Invalid data-schema ref ${JSON.stringify(ref)}: must start with '@' ` +
        `(e.g. '@/member' for this foundation, or '@uniweb/person' for a shared standard).`
    )
  }
  const slash = ref.indexOf('/')
  if (slash === -1) {
    throw new Error(`Invalid data-schema ref '${ref}': expected '@<scope>/<name>' (use '@/<name>' for this foundation).`)
  }
  const scope = ref.slice(1, slash) // '' for '@/...'
  const name = ref.slice(slash + 1)
  if (!name || name.includes('/')) {
    throw new Error(`Invalid data-schema ref '${ref}': expected a single '<name>' segment after the namespace.`)
  }
  return { scope, name }
}

/**
 * Collect every distinct schema ref used by a foundation's section bindings.
 * Reads the new binding shapes — `data: { key: '<ref>' }` (short) and
 * `data: { key: { schema: '<ref>', ... } }` (full). Non-string / schemaless
 * entries are ignored here; `resolveSchemaRef` validates each collected ref.
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
 * Resolve one ref to its canonical schema object.
 *
 * @param {string} ref
 * @param {{ srcDir: string }} ctx - Foundation source root
 * @returns {Promise<Object>} canonical schema `{ name, version?, fields }`
 */
export async function resolveSchemaRef(ref, { srcDir }) {
  const { scope, name } = parseSchemaRef(ref)

  if (scope === '') {
    const file = findSelfSchemaFile(srcDir, name)
    if (!file) {
      const tried = SCHEMA_EXTENSIONS.map((e) => `schemas/${name}${e}`).join(', ')
      throw new Error(`Data schema '${ref}' not found. Expected one of: ${tried} under the foundation root.`)
    }
    return normalizeSchema(await loadSchemaFile(file), ref)
  }

  if (scope === 'uniweb') {
    const schema = await resolveStandardSchema(name, srcDir)
    if (!schema) {
      throw new Error(`Unknown standard schema '${ref}': '@uniweb/schemas' exports no schema named '${name}'.`)
    }
    return normalizeSchema(schema, ref)
  }

  throw new Error(
    `Data-schema namespace '@${scope}' is not resolvable yet (ref '${ref}'). ` +
      `This pass supports '@/<name>' (this foundation) and '@uniweb/<name>' (shared standards).`
  )
}

/**
 * Resolve every ref in `refs` to its canonical schema, keyed by ref verbatim
 * (so `@/`-refs stay namespace-relative and travel with the foundation).
 *
 * @param {Iterable<string>} refs
 * @param {{ srcDir: string }} ctx
 * @returns {Promise<Object>} `{ [ref]: canonicalSchema }`
 */
export async function buildDataSchemaMap(refs, { srcDir }) {
  const map = {}
  for (const ref of refs) {
    map[ref] = await resolveSchemaRef(ref, { srcDir })
  }
  return map
}

// --- internals -------------------------------------------------------------

function findSelfSchemaFile(srcDir, name) {
  for (const ext of SCHEMA_EXTENSIONS) {
    const candidate = join(srcDir, 'schemas', name + ext)
    if (existsSync(candidate)) return candidate
  }
  return null
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
 * Load the `@uniweb/schemas` package from the FOUNDATION's context and pull the
 * named standard. Resolving from the foundation (not the build) lets each
 * foundation pin its own `@uniweb/schemas` version.
 */
async function resolveStandardSchema(name, srcDir) {
  const req = createRequire(join(srcDir, 'package.json'))
  let entry
  try {
    entry = req.resolve('@uniweb/schemas')
  } catch {
    throw new Error(
      `'@uniweb/schemas' is not installed in this foundation, but a schema ref needs it. ` +
        `Add '@uniweb/schemas' to the foundation's dependencies to use '@uniweb/<name>' refs.`
    )
  }
  const mod = await import(pathToFileURL(entry).href)
  if (typeof mod.getSchema === 'function') return mod.getSchema(name)
  return mod.schemas?.[name] ?? mod.default?.[name]
}

function normalizeSchema(schema, ref) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`Data schema '${ref}' did not export a schema object.`)
  }
  if (!schema.fields || typeof schema.fields !== 'object' || Array.isArray(schema.fields)) {
    throw new Error(`Data schema '${ref}' has no 'fields' map (expected the { name, version, fields } shape).`)
  }
  return schema
}
