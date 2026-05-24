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
 *   '@uniweb/name'   → the shared standards namespace: the schema named `name`
 *                      from the `@uniweb/schemas` package, resolved from the
 *                      FOUNDATION's node_modules
 *   '@scope/name'    → another publisher's namespace (not exercised this pass)
 *
 * The authoring format and its mapping to the server's Model/Section/Type is
 * `kb/framework/plans/data-schema-format.md`. This module validates that format
 * and normalizes the friendly type vocabulary to the canonical kinds; the
 * SERVER lowers the structure to Model/Section/Type (we don't).
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'

// Extensions a foundation-local schema file may use, in resolution order.
const SCHEMA_EXTENSIONS = ['.js', '.json', '.yml', '.yaml']

// The authoring type vocabulary. Scalars + structural; aliases fold in below.
const SCALAR_KINDS = new Set([
  'string', 'text', 'richtext', 'int', 'decimal', 'bool',
  'date', 'datetime', 'file', 'json',
])
const STRUCTURAL_KINDS = new Set(['object', 'array', 'ref'])
// Friendly aliases → canonical kind.
const TYPE_ALIASES = {
  markdown: 'richtext',
  number: 'decimal',
  integer: 'int',
  boolean: 'bool',
  image: 'file',
}
// Type aliases that lower to `string` + a `format` (semantic strings).
const FORMAT_TYPES = new Set(['url', 'email'])
const SECTION_KINDS = new Set(['single', 'multi', 'binder'])

/**
 * Parse a data-schema ref into `{ scope, name }`.
 *   '@/member'       → { scope: '',       name: 'member' }   (self namespace)
 *   '@uniweb/person' → { scope: 'uniweb', name: 'person' }
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
export async function resolveSchemaRef(ref, { srcDir }) {
  const { scope, name } = parseSchemaRef(ref)

  if (scope === '') {
    const file = findSelfSchemaFile(srcDir, name)
    if (!file) {
      const tried = SCHEMA_EXTENSIONS.map((e) => `schemas/${name}${e}`).join(', ')
      throw new Error(`Data schema '${ref}' not found. Expected one of: ${tried} under the foundation root.`)
    }
    return validateAndNormalizeSchema(await loadSchemaFile(file), ref)
  }

  if (scope === 'uniweb') {
    const schema = await resolveStandardSchema(name, srcDir)
    if (!schema) {
      throw new Error(`Unknown standard schema '${ref}': '@uniweb/schemas' exports no schema named '${name}'.`)
    }
    return validateAndNormalizeSchema(schema, ref)
  }

  throw new Error(
    `Data-schema namespace '@${scope}' is not resolvable yet (ref '${ref}'). ` +
      `This pass supports '@/<name>' (this foundation) and '@uniweb/<name>' (shared standards).`
  )
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
  const map = {}
  const queue = Array.from(refs)
  while (queue.length > 0) {
    const ref = queue.shift()
    if (map[ref]) continue
    map[ref] = await resolveSchemaRef(ref, { srcDir })
    for (const target of collectNestedRefs(map[ref])) {
      if (!map[target]) queue.push(target)
    }
  }
  return map
}

// --- validation + normalization --------------------------------------------

/**
 * Validate a schema definition against the authoring format and return a
 * normalized copy (type aliases folded to canonical kinds). Pure — no I/O.
 * Throws an Error naming the schema + the offending field/section.
 *
 * @param {Object} schema - the schema as authored
 * @param {string} ref - for error messages (e.g. '@/product')
 * @returns {Object} normalized schema
 */
export function validateAndNormalizeSchema(schema, ref) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`Data schema '${ref}' did not export a schema object.`)
  }

  const out = {}
  for (const k of ['name', 'version', 'description', 'sortDate']) {
    if (schema[k] !== undefined) out[k] = schema[k]
  }

  const hasFields = schema.fields !== undefined
  const hasSections = schema.sections !== undefined
  if (hasFields && hasSections) {
    throw new Error(`Data schema '${ref}': declare either 'fields' (shorthand) or 'sections', not both.`)
  }
  if (!hasFields && !hasSections) {
    throw new Error(`Data schema '${ref}': must declare 'fields' or 'sections'.`)
  }

  if (hasSections) {
    out.sections = normalizeSections(schema.sections, ref)
  } else {
    out.fields = normalizeFields(schema.fields, ref, '')
  }
  return out
}

function normalizeSections(sections, ref) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new Error(`Data schema '${ref}': 'sections' must be a map of section name → definition.`)
  }
  const briefState = { count: 0 }
  const out = {}
  for (const [name, section] of Object.entries(sections)) {
    out[name] = normalizeSection(section, ref, `sections.${name}`, briefState)
  }
  return out
}

function normalizeSection(section, ref, path, briefState) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(`Data schema '${ref}': section '${path}' must be an object.`)
  }
  const kind = section.kind ?? 'single'
  if (!SECTION_KINDS.has(kind)) {
    throw new Error(`Data schema '${ref}': section '${path}' has invalid kind '${kind}' (expected single | multi | binder).`)
  }
  const out = { kind }

  if (section.brief === true) {
    if (kind !== 'single') {
      throw new Error(`Data schema '${ref}': brief section '${path}' must be kind 'single', not '${kind}'.`)
    }
    if (++briefState.count > 1) {
      throw new Error(`Data schema '${ref}': more than one section marked 'brief: true' (at most one).`)
    }
    out.brief = true
  }

  if (kind === 'binder') {
    if (section.fields !== undefined) {
      throw new Error(`Data schema '${ref}': binder section '${path}' carries only child 'sections', not 'fields'.`)
    }
    if (section.sections === undefined) {
      throw new Error(`Data schema '${ref}': binder section '${path}' must declare child 'sections'.`)
    }
  }
  if (section.fields !== undefined) out.fields = normalizeFields(section.fields, ref, path)
  if (section.sections !== undefined) {
    const childBrief = { count: 0 }
    out.sections = {}
    for (const [n, s] of Object.entries(section.sections)) {
      out.sections[n] = normalizeSection(s, ref, `${path}.sections.${n}`, childBrief)
    }
  }
  if (section.constraints !== undefined) out.constraints = section.constraints
  return out
}

function normalizeFields(fields, ref, path) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`Data schema '${ref}': 'fields'${path ? ` in '${path}'` : ''} must be a map of field name → definition.`)
  }
  const out = {}
  for (const [name, field] of Object.entries(fields)) {
    out[name] = normalizeField(field, ref, path ? `${path}.${name}` : name)
  }
  return out
}

function normalizeField(field, ref, path) {
  // Shorthand: a bare type string.
  if (typeof field === 'string') field = { type: field }
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw new Error(`Data schema '${ref}': field '${path}' must be an object or a type string.`)
  }
  const rawType = field.type
  if (typeof rawType !== 'string') {
    throw new Error(`Data schema '${ref}': field '${path}' has no 'type'.`)
  }

  const out = {}
  // Carry-through metadata (render hints / flags / value).
  for (const k of ['required', 'default', 'label', 'help', 'description', 'translatable', 'format']) {
    if (field[k] !== undefined) out[k] = field[k]
  }

  // Resolve the type: format-aliases (url/email) → string + format; else alias map.
  if (FORMAT_TYPES.has(rawType)) {
    out.type = 'string'
    out.format = field.format ?? rawType
  } else {
    out.type = TYPE_ALIASES[rawType] ?? rawType
  }

  if (!SCALAR_KINDS.has(out.type) && !STRUCTURAL_KINDS.has(out.type)) {
    throw new Error(
      `Data schema '${ref}': field '${path}' has unknown type '${rawType}'. ` +
        `Known: ${[...SCALAR_KINDS, ...STRUCTURAL_KINDS, ...Object.keys(TYPE_ALIASES), ...FORMAT_TYPES].sort().join(', ')}.`
    )
  }

  // Picklists: enum = inline list; options = a curated '@/x' ref (item_ref).
  if (field.enum !== undefined) {
    if (!Array.isArray(field.enum)) {
      throw new Error(`Data schema '${ref}': field '${path}' 'enum' must be a list of values.`)
    }
    out.enum = field.enum
  }
  if (field.options !== undefined) {
    if (typeof field.options !== 'string' || field.options[0] !== '@') {
      throw new Error(
        `Data schema '${ref}': field '${path}' 'options' must be a '@/<name>' ref to a curated options schema. ` +
          `For an inline list use 'enum:'.`
      )
    }
    parseSchemaRef(field.options) // shape-check the ref
    out.options = field.options
  }

  // Structural kinds.
  if (out.type === 'object') {
    if (field.fields === undefined) {
      throw new Error(`Data schema '${ref}': object field '${path}' must declare nested 'fields'.`)
    }
    out.fields = normalizeFields(field.fields, ref, path)
  } else if (out.type === 'array') {
    // `items` (the element type) is recommended but optional — an array with
    // no declared element type is an untyped list.
    if (field.items !== undefined) {
      out.items = normalizeField(field.items, ref, `${path}[]`)
    }
  } else if (out.type === 'ref') {
    if (typeof field.ref !== 'string' || field.ref[0] !== '@') {
      throw new Error(`Data schema '${ref}': ref field '${path}' must name a target schema, e.g. ref: '@/person'.`)
    }
    parseSchemaRef(field.ref)
    out.ref = field.ref
  }

  return out
}

/**
 * Walk a normalized schema and collect every nested `ref`/`options` target —
 * the data schemas this one depends on. Used to close the resolution graph.
 *
 * @param {Object} schema - a normalized schema
 * @returns {string[]} distinct ref strings
 */
export function collectNestedRefs(schema) {
  const found = new Set()
  const walkFields = (fields) => {
    for (const field of Object.values(fields || {})) {
      if (typeof field !== 'object' || !field) continue
      if (typeof field.ref === 'string') found.add(field.ref)
      if (typeof field.options === 'string') found.add(field.options)
      if (field.fields) walkFields(field.fields)
      if (field.items) walkFields({ _: field.items })
    }
  }
  const walkSections = (sections) => {
    for (const section of Object.values(sections || {})) {
      if (section?.fields) walkFields(section.fields)
      if (section?.sections) walkSections(section.sections)
    }
  }
  if (schema?.fields) walkFields(schema.fields)
  if (schema?.sections) walkSections(schema.sections)
  return [...found]
}

// --- internals --------------------------------------------------------------

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
