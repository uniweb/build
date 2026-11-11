/**
 * A foundation's mappings — `src/mappings/<name>.yml`, one per file: how a vendor's file translates
 * to and from one of the foundation's types (a catalog CSV ⇄ `@/vehicle`, a lead's XML ⇄ `@/lead`).
 *
 * ```yaml
 * # src/mappings/vehicle-to-meta.yml
 * label: Meta catalog
 * model: '@/vehicle'            # the type, named as a data schema names one
 * direction: out
 * shape: list
 * format: { type: csv }
 * key: id
 * keys_from: '@/dms-inventory'  # optional: another mapping
 * fields:
 *   - { title: listing.title }
 * ```
 *
 * ⭐ THE FOLDER IS THE DECLARATION, as `schemas/` is for data schemas (`ownSchemaFiles`): a file is
 * a mapping by being there, its name is the file's, a name with a leading `_` is left out, and
 * `.js .json .yml .yaml` all count.
 *
 * ⭐ THE BACKEND JUDGES THE RULES. A mapping is registered with its foundation (`registry-package.js`,
 * `@uniweb/mapping-schema`) and a backend checks it there. The build refuses only what can't be
 * registered at all, so the author learns of it at the build and not at `register`:
 *
 *   - a file that is not a map, or a `label`/`description` that is not text;
 *   - a `model` that is missing or names no type, or an `@/x` the foundation doesn't define;
 *   - a `keys_from` that names no mapping, or an `@/x` that isn't one of the foundation's;
 *   - a reverse `follow` line's `model` that names no type, or an `@/x` the foundation doesn't define.
 *
 * Mappings are editor-time only: they ride in `schema.json` as `_mappings` and never reach a page.
 *
 * @module
 */

import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { SCHEMA_EXTENSIONS, parseSchemaRef } from '@uniweb/schemas/format'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'

/** The folder, under a foundation's source root. */
export const MAPPINGS_DIR = 'mappings'

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The mapping files a foundation defines, by name, sorted.
 *
 * @param {string} srcDir - the foundation's source root
 * @returns {{ name: string, file: string }[]}
 */
export function ownMappingFiles(srcDir) {
  const dir = join(srcDir, MAPPINGS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .sort()
    .filter((file) => SCHEMA_EXTENSIONS.includes(extname(file)) && !file.startsWith('_'))
    .map((file) => ({ name: basename(file, extname(file)), file: join(dir, file) }))
}

/** One mapping file, as written. */
export async function loadMappingFile(file) {
  if (file.endsWith('.js')) return (await import(pathToFileURL(file).href)).default
  const text = await readFile(file, 'utf8')
  return file.endsWith('.json') ? JSON.parse(text) : yaml.load(text, YAML_OPTIONS)
}

/**
 * Read and check every mapping a foundation defines.
 *
 * @param {string} srcDir - the foundation's source root
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.ownTypes] - the `@/x` data schemas the foundation defines
 * @param {string} [opts.shownIn] - the folder as its errors name it (a library's is `mappings`)
 * @returns {Promise<Object<string, object>>} `{ '@/<name>': declaration }` as written (`@/x` unqualified)
 * @throws {Error} naming every mapping that cannot be registered, and why
 */
export async function buildMappingMap(srcDir, { ownTypes = [], shownIn = `src/${MAPPINGS_DIR}` } = {}) {
  const files = ownMappingFiles(srcDir)
  if (!files.length) return {}
  const types = new Set(ownTypes)
  const names = new Set(files.map(({ name }) => `@/${name}`))
  const map = {}
  const found = []
  for (const { name, file } of files) {
    const at = `${shownIn}/${basename(file)}`
    let decl
    try {
      decl = await loadMappingFile(file)
    } catch (err) {
      found.push(`${at}: ${String(err?.message || err).split('\n')[0]}`)
      continue
    }
    const problems = mappingProblems(decl, { types, names })
    if (problems.length) found.push(...problems.map((p) => `${at}: ${p}`))
    else map[`@/${name}`] = decl
  }
  if (found.length) {
    throw new Error(
      found.length === 1
        ? `[uniweb] ${found[0]}`
        : `[uniweb] mappings that cannot be registered:\n${found.map((f) => `  - ${f}`).join('\n')}`
    )
  }
  return map
}

/**
 * What stops one mapping from registering — `[]` when nothing does.
 *
 * @param {*} decl - the file, as read
 * @param {{ types: Set<string>, names: Set<string> }} own - the foundation's `@/x` types and mappings
 * @returns {string[]}
 */
export function mappingProblems(decl, { types, names }) {
  if (!isMap(decl)) return ['a mapping is a map — `model:`, `direction:`, `fields:` and the rest.']
  const found = []
  for (const key of ['label', 'description']) {
    if (key in decl && (typeof decl[key] !== 'string' || !decl[key].trim())) {
      found.push(`\`${key}\` is text.`)
    }
  }
  if (!('model' in decl)) {
    found.push("`model` is missing: name the type the mapping translates, `model: '@/vehicle'`.")
  } else {
    const problem = refProblem('model', decl.model, 'type')
    if (problem) found.push(problem)
    else if (decl.model.startsWith('@/') && !types.has(decl.model)) {
      found.push(`\`model\` is \`${decl.model}\`, which is not one of the foundation's types (src/schemas/).`)
    }
  }
  if ('keys_from' in decl) {
    const problem = refProblem('keys_from', decl.keys_from, 'mapping')
    if (problem) found.push(problem)
    else if (decl.keys_from.startsWith('@/') && !names.has(decl.keys_from)) {
      found.push(`\`keys_from\` is \`${decl.keys_from}\`, which is not one of the foundation's mappings (src/${MAPPINGS_DIR}/).`)
    }
  }
  found.push(...followProblems(decl.follow, types))
  return found
}

/**
 * A mapping with every type and mapping it names in full (`scoped`: `@/x` → `@scope/x`): its `model`,
 * its `keys_from` and a reverse `follow` line's `model`. Nothing else moves, and the file's own object
 * is never touched.
 *
 * @param {object} decl - as written
 * @param {(ref: string) => string} scoped
 * @returns {object}
 */
export function mappingInFull(decl, scoped) {
  const out = { ...decl }
  if (typeof out.model === 'string') out.model = scoped(out.model)
  if (typeof out.keys_from === 'string') out.keys_from = scoped(out.keys_from)
  if (Array.isArray(out.follow)) {
    out.follow = out.follow.map((line) =>
      isMap(line)
        ? Object.fromEntries(
            Object.entries(line).map(([alias, spec]) =>
              isMap(spec) && typeof spec.model === 'string' ? [alias, { ...spec, model: scoped(spec.model) }] : [alias, spec]
            )
          )
        : line
    )
  }
  return out
}

/**
 * `follow` — a list of one-entry maps, `{ alias: { field, from? } }` forward, or
 * `{ alias: { model, field, names? } }` reverse. Only a reverse line's `model` is a name (a type);
 * the rest is local and the backend's to judge, as is a `follow` shaped any other way.
 */
export function followModels(follow) {
  if (!Array.isArray(follow)) return []
  const out = []
  for (const [i, line] of follow.entries()) {
    if (!isMap(line)) continue
    for (const [alias, spec] of Object.entries(line)) {
      if (isMap(spec) && 'model' in spec) out.push({ at: `follow[${i}].${alias}.model`, spec })
    }
  }
  return out
}

function followProblems(follow, types) {
  const found = []
  for (const { at, spec } of followModels(follow)) {
    const problem = refProblem(at, spec.model, 'type')
    if (problem) found.push(problem)
    else if (spec.model.startsWith('@/') && !types.has(spec.model)) {
      found.push(`\`${at}\` is \`${spec.model}\`, which is not one of the foundation's types (src/schemas/).`)
    }
  }
  return found
}

function refProblem(key, ref, what) {
  try {
    parseSchemaRef(ref)
    return null
  } catch {
    return `\`${key}\` names no ${what}: one of the foundation's own is \`'@/<name>'\`, any other is named in full, \`'@scope/<name>'\`.`
  }
}
