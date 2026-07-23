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
 * The authoring format and its canonical type vocabulary are documented in
 * `data-schema-format.md`. This module validates that format and normalizes the
 * friendly type aliases to the canonical kinds. Normalization is the only
 * transformation it performs — it does not lower the structure to any storage
 * model.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, isAbsolute, extname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'

// Extensions a foundation-local schema file may use, in resolution order.
const SCHEMA_EXTENSIONS = ['.js', '.json', '.yml', '.yaml']

// The authoring type vocabulary. Scalars + structural; aliases fold in below.
// Exported so a conformance checker can speak the same definition of each kind
// that normalization produces — "normalizes" and "conforms" stay in lockstep.
export const SCALAR_KINDS = new Set([
  'string', 'text', 'int', 'decimal', 'bool',
  'date', 'datetime', 'file', 'json',
])
export const STRUCTURAL_KINDS = new Set(['object', 'array', 'ref'])
// Friendly aliases → canonical kind.
const TYPE_ALIASES = {
  number: 'decimal',
  integer: 'int',
  boolean: 'bool',
  image: 'file',
}
// Friendly type aliases that lower to a base kind + a carried `format` marker.
// `url`/`email` → `string` (server-validated value subtypes). `markdown`/`html` →
// `text` (a file-based rich-content body — round-trips as the raw source string).
const FORMAT_TYPE_ALIASES = {
  url: { type: 'string', format: 'url' },
  email: { type: 'string', format: 'email' },
  markdown: { type: 'text', format: 'markdown' },
  html: { type: 'text', format: 'html' },
  // `richtext` → a ProseMirror rich document (`json` + `format: prosemirror`): the
  // framework's standard way to represent rich text — the structured, lossless form
  // the visual app edits (text, media, tables, code, data blocks, icons, and inline
  // components). Synced to file mode as enhanced markdown via content-writer. Contrast
  // `markdown`/`html`, which are source-string bodies (raw text, no structured editor).
  richtext: { type: 'json', format: 'prosemirror' },
}
// The advertised format-aliasing type words (drives the "Known types" hint).
export const FORMAT_TYPES = new Set(['url', 'email', 'markdown', 'html', 'richtext'])
export const SECTION_KINDS = new Set(['single', 'multi', 'binder'])

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
 * Parse a data-schema ref into `{ scope, name }`.
 *   '@/member'       → { scope: '',    name: 'member' }   (self namespace)
 *   '@std/person'    → { scope: 'std', name: 'person' }
 */
export function parseSchemaRef(ref) {
  if (typeof ref !== 'string' || ref[0] !== '@') {
    throw new Error(
      `Invalid data-schema ref ${JSON.stringify(ref)}: must start with '@' ` +
        `(e.g. '@/member' for this foundation, or '@std/person' for a shared standard).`
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
  for (const k of ['name', 'version', 'description']) {
    if (schema[k] !== undefined) out[k] = schema[k]
  }

  // The model's sort axis names a DATE FIELD IN THE BRIEF section (not a boolean,
  // not a field-level flag) — the lowering stamps `sort_date: true` on that field.
  // Authored as `sort_date` (the authoring vocabulary is snake_case, like
  // `append_only`); `sortDate` is an accepted alias. Both normalize to `sortDate`,
  // the single key the lowering reads — carrying the two spellings through verbatim
  // meant an authored `sort_date` was silently dropped.
  const sortDate = schema.sort_date ?? schema.sortDate
  if (sortDate !== undefined) {
    if (typeof sortDate !== 'string') {
      throw new Error(
        `Data schema '${ref}': 'sort_date' must name a date field in the brief section, got ${typeof sortDate}.`
      )
    }
    out.sortDate = sortDate
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
  if (section.many !== undefined && typeof section.many !== 'boolean') {
    throw new Error(`Data schema '${ref}': section '${path}' 'many' must be a boolean.`)
  }
  // Cardinality. Friendly sugar: `many: true` → a list of records; a section with
  // only child `sections:` (no `fields:`) is a binder — inferred, never written.
  // Explicit `kind:` is still honored (the lower-level form it normalizes to).
  let kind = section.kind
  if (kind === undefined) {
    if (section.many === true) kind = 'multi'
    else if (section.fields === undefined && section.sections !== undefined) kind = 'binder'
    else kind = 'single'
  }
  if (!SECTION_KINDS.has(kind)) {
    throw new Error(`Data schema '${ref}': section '${path}' has invalid kind '${kind}' (expected single | multi | binder).`)
  }
  const out = { kind }

  if (section.brief === true) {
    if (kind !== 'single') {
      throw new Error(`Data schema '${ref}': brief section '${path}' must be a single record (drop 'many').`)
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

  // `tree: true` (friendly) / `nestable: true` (lower-level) — a list section whose
  // records form a tree among themselves. Carried into the IR so the lowering maps
  // it to the model's `self_nesting`. The parent/child link is internal to the
  // backend (`parent_item_id`); no explicit field expresses it.
  const treeFlag = section.tree ?? section.nestable
  if (treeFlag !== undefined) {
    if (typeof treeFlag !== 'boolean') {
      throw new Error(`Data schema '${ref}': section '${path}' 'tree' must be a boolean.`)
    }
    if (treeFlag && kind !== 'multi') {
      throw new Error(`Data schema '${ref}': section '${path}' is 'tree: true' but not a list — only a 'many: true' section can form a tree.`)
    }
    if (treeFlag) out.nestable = true
  }

  // `append_only` — a multi whose records are insert-only: the backend accepts
  // appends but refuses edits or deletes of existing items, so the section is
  // tamper-evident (activity logs, submissions, audit trails). Carried into the IR
  // verbatim for the submission lowering to emit as the model's `append_only`.
  // Like `nestable`, only a `multi` section can be append-only.
  if (section.append_only !== undefined) {
    if (typeof section.append_only !== 'boolean') {
      throw new Error(`Data schema '${ref}': section '${path}' 'append_only' must be a boolean.`)
    }
    if (section.append_only && kind !== 'multi') {
      throw new Error(`Data schema '${ref}': section '${path}' is 'append_only: true' but not a list — only a 'many: true' section can be append-only.`)
    }
    if (section.append_only) out.append_only = true
  }

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

  // Sugar: `many: true` → a list. Wrap the field-minus-`many` as the array's item
  // type (lowers to the canonical `multiple`). The common cases —
  // `{ ref: '@/x', many: true }`, `{ type: string, many: true }` — read as "a list
  // of X" with no `array`/`items` ceremony.
  if (field.many !== undefined) {
    if (typeof field.many !== 'boolean') {
      throw new Error(`Data schema '${ref}': field '${path}' 'many' must be a boolean.`)
    }
    if (field.many) {
      // Collection-level metadata (required, default, label, help, description)
      // rides on the array; the type-bearing attributes describe each item.
      const ITEM_KEYS = new Set(['type', 'ref', 'options', 'enum', 'fields', 'items', 'format'])
      const out = { type: 'array' }
      const item = {}
      for (const [k, v] of Object.entries(field)) {
        if (k === 'many') continue
        if (ITEM_KEYS.has(k)) item[k] = v
        else out[k] = v
      }
      out.items = normalizeField(item, ref, `${path}[]`)
      return out
    }
    const { many, ...rest } = field // many: false → a single value
    field = rest
  }

  // Sugar: infer `type` from `ref:`/`options:` when omitted — `{ ref: '@/x' }` is a
  // reference; `{ options: '@/x' }` is a curated picklist value.
  if (field.type === undefined) {
    if (typeof field.ref === 'string') field = { ...field, type: 'ref' }
    else if (typeof field.options === 'string') field = { ...field, type: 'string' }
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

  // Resolve the type: format-aliases (url/email → string; markdown/html → text;
  // richtext → json) carry a `format` marker; else the plain alias map; else verbatim.
  const formatAlias = FORMAT_TYPE_ALIASES[rawType]
  if (formatAlias) {
    out.type = formatAlias.type
    out.format = field.format ?? formatAlias.format
  } else {
    out.type = TYPE_ALIASES[rawType] ?? rawType
  }

  if (!SCALAR_KINDS.has(out.type) && !STRUCTURAL_KINDS.has(out.type)) {
    throw new Error(
      `Data schema '${ref}': field '${path}' has unknown type '${rawType}'. ` +
        `Known: ${[...SCALAR_KINDS, ...STRUCTURAL_KINDS, ...Object.keys(TYPE_ALIASES), ...FORMAT_TYPES].sort().join(', ')}.`
    )
  }

  // Content `format` markers are registered per-shape (uwx-format.md §3): the
  // rich-content markers `markdown`/`html` belong on a `text` field; `prosemirror`
  // (a ProseMirror doc) and `scene` (a Scene Composition Format payload — an opaque
  // structured blob the app edits via the Designer / visual canvas) both belong on
  // a `json` field. Catch a mismatch at build time, not at publish (the backend
  // rejects it). Value-validator formats (email/url) are unrestricted here.
  if ((out.format === 'markdown' || out.format === 'html') && out.type !== 'text') {
    throw new Error(
      `Data schema '${ref}': field '${path}' has format '${out.format}', valid only on a 'text' field (got '${out.type}').`
    )
  }
  if ((out.format === 'prosemirror' || out.format === 'scene') && out.type !== 'json') {
    throw new Error(
      `Data schema '${ref}': field '${path}' has format '${out.format}', valid only on a 'json' field (got '${out.type}').`
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
 * Load an org's schema package from the FOUNDATION's context and pull the named
 * schema. Resolving from the foundation (not the build) lets each foundation pin
 * its own version of a shared schema package. The standard schemas ship in
 * `@uniweb/schemas` (referenced as `@std`); an org's own schemas ship in its
 * `@org/schemas` package — commonly a workspace package shared across the team's
 * foundations during local development.
 */
async function resolveScopedSchema(pkg, name, srcDir) {
  const req = createRequire(join(srcDir, 'package.json'))
  let entry
  try {
    entry = req.resolve(pkg)
  } catch {
    throw new Error(
      `'${pkg}' is not installed in this foundation, but a schema ref needs it. ` +
        `Add '${pkg}' to the foundation's dependencies to resolve those refs.`
    )
  }
  const mod = await import(pathToFileURL(entry).href)
  if (typeof mod.getSchema === 'function') return mod.getSchema(name)
  return mod.schemas?.[name] ?? mod.default?.[name]
}
