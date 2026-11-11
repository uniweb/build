/**
 * A site's backend blueprint — `blueprint.yml`, beside `site.yml`: how a backend started from this
 * site begins. Who may sign up, the teams it founds, who may add and see each type, and what
 * visitors may read.
 *
 * ```yaml
 * signup: invite_only                  # open (the default), or invite_only
 * teams:                               # founded empty: who is in one is set in the admin app
 *   sales: { label: Sales }
 * access:
 *   '@/vehicle':
 *     add: [sales]                     # open, a list of teams, or [] for none
 *     all: { sales: edit }             # a team, or members, to read or edit
 * publicQueries:                       # what visitors who are not signed in may read
 *   '@/vehicle': { whole: true, where: { status: { in: [available, pending] } } }
 * ```
 *
 * ⭐ IT IS THE `backend` SERVICE'S, KEPT IN A FILE OF ITS OWN. A push sends it in that service's
 * row, as `config.blueprint`, beside the rest of what `site.yml::services.backend` asks; a pull
 * lifts it out again and writes it here, and never into `site.yml`. Every other key of the row's
 * `config` round-trips as `services-request.js` says.
 *
 * ⭐ A TYPE IS NAMED AS ITS FOUNDATION NAMES IT — `@/x` for one of the site's foundation's own, a
 * full name for any other, as `data:` and `queries.yml` name types — and a push names each in full
 * by the rule every ref it sends follows (`qualifyRef`, with the scope `siteSelfScope` reads). The
 * backend never resolves an `@/x`. A pull writes `@/x` back, and keeps a name the file already
 * spells another way when it names the same type.
 *
 * ⭐ ITS SHAPE IS THE BACKEND'S, AND THE BACKEND CHECKS IT AT EVERY DOOR THAT WRITES THE ROW. The
 * checks here come earlier — a build, a push, `uniweb doctor`, offline — and refuse no more than
 * the file's shape: its keys, team ids and labels, levels, and a public query's `whole`. Two things
 * are left to a backend that starts from it:
 *
 *   - whether a public query's `where`, `sort` and `limit` make a set it can serve, which only it
 *     can judge against the types it installs;
 *   - a type none of the site's foundations declares: a warning here (`blueprintWarnings`), never a
 *     refusal, since a backend started from the site leaves that line out and says so.
 *
 * ⭐ NOTHING OF IT REACHES A PAGE. A static build checks it and writes it nowhere: no page reads how
 * a backend began.
 *
 * Read by the static build (`site/content-collector.js`), the push (`site.js`, `sync-package.js`),
 * the pull (`site-project.js`) and the CLI's `doctor`.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { qualifyRef } from '@uniweb/schemas/refs'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { unresolveSelfScope, bareOrg } from './self-scope.js'
import { writeYamlFile } from './project-writer.js'
import { detectFoundationType } from '../site/foundation-ref.js'
import { findSiteExtension, extensionNameOf } from '../site/workspace-extension.js'
import { resolveFoundationSrcPath } from '../utils/foundation-source-root.js'
import { buildSchema, readFoundationName } from '../schema.js'
import { splitFoundationName } from '../foundation-name.js'
import { BLUEPRINT_FILE, TYPE_KEYS, readBlueprint } from './blueprint-file.js'

// The file half — read and checked — is its own light module, so `uniweb dev`'s mock can read the file
// without the push and the pull (`./blueprint-file.js`, `@uniweb/build/blueprint`).
export { BLUEPRINT_FILE, BLUEPRINT_KEYS, readBlueprint, blueprintProblems, refuseUnreadableBlueprint } from './blueprint-file.js'

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Deterministic JSON: object keys sorted at every depth, arrays left in order. */
function stable(value) {
  return JSON.stringify(value ?? null, (_k, v) =>
    isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
  )
}

// ── On the wire ───────────────────────────────────────────────────────────────────

/**
 * The blueprint as a push sends it, `config.blueprint` of the `backend` row: the file key for key,
 * each type named in full. Only the names change.
 *
 * @param {object} blueprint - a checked blueprint (`refuseUnreadableBlueprint`)
 * @param {string|null} scope - the scope the site's `@/x` resolve into (`siteSelfScope`); with none,
 *        an `@/x` goes as written (`blueprintWarnings` says so)
 * @returns {object}
 * @throws {Error} when two names in one key name the same type
 */
export function blueprintForWire(blueprint, scope) {
  const out = {}
  for (const [key, value] of Object.entries(blueprint)) {
    out[key] = TYPE_KEYS.includes(key) && isMap(value) ? qualifiedTypes(key, value, scope) : value
  }
  return out
}

/**
 * Whether two blueprints, each as a `backend` row holds it (`blueprintForWire`), say the same: keys in
 * any order, lists in theirs. `undefined` and `null` are no blueprint, the same as each other and
 * never the same as one. A pull asks it before it writes the file (`writePulledBlueprint`), and the
 * CLI before it says that a change reaches no backend already started from the site.
 *
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function sameBlueprint(a, b) {
  return stable(a) === stable(b)
}

/** A map of types with each key in full. ⛔ Two keys for one type cannot both go: refused by name. */
function qualifiedTypes(key, map, scope) {
  const out = {}
  const from = new Map()
  for (const [type, value] of Object.entries(map)) {
    const full = qualifyRef(type, scope)
    if (from.has(full)) {
      throw new Error(
        `[uniweb] ${BLUEPRINT_FILE}: \`${key}.${from.get(full)}\` and \`${key}.${type}\` name one type, \`${full}\`. Keep one of them.`
      )
    }
    from.set(full, type)
    out[full] = value
  }
  return out
}

/**
 * The blueprint a row holds → the file a pull writes: each type of the site's foundation's own as
 * `@/x` again (`unresolveSelfScope`), or as the file already spells it.
 *
 * @param {object} wire - the row's `config.blueprint`
 * @param {object} [opts]
 * @param {string|null} [opts.scope] - the scope the push qualified with
 * @param {Set<string>|null} [opts.own] - the data schemas the foundation defines, when known
 * @param {object|null} [opts.local] - the file as it stands, whose spelling of a type is kept
 * @returns {object}
 */
export function blueprintFromWire(wire, { scope = null, own = null, local = null } = {}) {
  const out = {}
  for (const [key, value] of Object.entries(isMap(wire) ? wire : {})) {
    if (!TYPE_KEYS.includes(key) || !isMap(value)) {
      out[key] = value
      continue
    }
    const spelled = spellingsOf(local?.[key], scope)
    out[key] = Object.fromEntries(
      Object.entries(value).map(([type, line]) => [spelled.get(type) ?? unresolveSelfScope(type, scope, own), line])
    )
  }
  return out
}

/** Each type a file's key names, in full → as the file spells it. */
function spellingsOf(map, scope) {
  const out = new Map()
  if (isMap(map)) for (const type of Object.keys(map)) out.set(qualifyRef(type, scope), type)
  return out
}

// ── A pull ────────────────────────────────────────────────────────────────────────

/**
 * The site's `services` rows with the blueprint lifted out of the `backend` row, for `site.yml` —
 * and the blueprint, for its file.
 *
 * @param {object[]} rows - the `services` Section
 * @returns {{ rows: object[], blueprint: object|undefined, backend: boolean }} `backend`: whether
 *          the site has a `backend` row at all
 */
export function liftBlueprint(rows) {
  let blueprint
  let backend = false
  const out = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!isMap(row) || row.name !== 'backend') return row
    backend = true
    if (!isMap(row.config) || !('blueprint' in row.config)) return row
    const { blueprint: held, ...config } = row.config
    blueprint = held
    return { ...row, config }
  })
  return { rows: out, blueprint, backend }
}

/**
 * Write what the site's `backend` row holds to `blueprint.yml` — or leave the file as it is.
 *
 * ⭐ A FILE THAT SAYS WHAT THE ROW SAYS IS LEFT AS WRITTEN: compared as a push would send it, so a
 * pull of what was pushed changes no file. One that differs is edited, its comments kept
 * (`writeYamlFile`).
 *
 * ⭐ A ROW WITH NO BLUEPRINT LEAVES AN EXISTING FILE ALONE, and says so: the file is the author's
 * account of how a backend begins, and a site that holds none has not said otherwise. The next push
 * sends it.
 *
 * @param {object} p
 * @param {string} p.siteRoot
 * @param {object[]} p.rows - the `services` Section
 * @param {string|null} [p.scope] - the scope the push qualified the types with
 * @param {Set<string>|null} [p.own] - the data schemas the foundation defines, when known
 * @returns {{ file: 'updated'|'unchanged'|'kept'|null, note?: string }} `kept`: a file the pull
 *          left alone, with the sentence that says why
 */
export function writePulledBlueprint({ siteRoot, rows, scope = null, own = null }) {
  const { blueprint, backend } = liftBlueprint(rows)
  const path = join(siteRoot, BLUEPRINT_FILE)
  if (blueprint === undefined) {
    if (!existsSync(path)) return { file: null }
    return {
      file: 'kept',
      note: backend
        ? `The site's backend holds no blueprint, so ${BLUEPRINT_FILE} is left as it is. The next push sends it.`
        : `The site asks for no backend, so ${BLUEPRINT_FILE} is left as it is. A push sends it once site.yml asks for one (\`services: { backend: true }\`).`
    }
  }
  let local = null
  try {
    local = readBlueprint(siteRoot)
  } catch {
    local = null // a file a push could not read either: written over with what the site holds
  }
  if (local && saysTheSame(local, blueprint, scope)) return { file: 'unchanged' }
  return { file: writeYamlFile(path, blueprintFromWire(blueprint, { scope, own, local })) }
}

/** Whether the file, as a push would send it, is what the row holds. */
function saysTheSame(local, wire, scope) {
  try {
    return sameBlueprint(blueprintForWire(local, scope), wire)
  } catch {
    return false
  }
}

// ── What a backend started from the site will leave out ───────────────────────────

/**
 * What to tell the author about a blueprint before a backend is started from it — `[]` when there
 * is nothing. Never a refusal: a backend leaves out a line it cannot apply, and says so when it
 * starts. Said here so the author learns of it while still at the file:
 *
 *   - a type none of the site's foundations declares, which a backend started from the site does
 *     not install. Said only when every foundation the site uses could be read here: one that
 *     cannot be — a cataloged foundation, whose data schemas travel as Models — might declare it;
 *   - an `@/x` a push cannot name in full, because the foundation has no scope yet — said by a
 *     push alone (`sending`): a project's foundation has none until its first `register`, and a
 *     build sends nothing.
 *
 * @param {object|null} blueprint - a checked blueprint (`refuseUnreadableBlueprint`)
 * @param {object} p
 * @param {string|null} p.scope - the scope the site's `@/x` resolve into
 * @param {{ types: Set<string>|null }} p.declared - what `siteDeclaredTypes` read
 * @param {boolean} [p.sending] - whether a push is about to send it
 * @returns {string[]}
 */
export function blueprintWarnings(blueprint, { scope, declared, sending = false }) {
  if (!isMap(blueprint)) return []
  const out = []
  const scoped = Boolean(bareOrg(scope))
  for (const key of TYPE_KEYS) {
    if (!isMap(blueprint[key])) continue
    for (const type of Object.keys(blueprint[key])) {
      const at = `${key}.${type}`
      if (!scoped && type.startsWith('@/') && sending) {
        out.push(
          `${BLUEPRINT_FILE}: \`${at}\` is the foundation's own type, and the foundation has no scope yet, ` +
            "so a push sends it as written — the backend never resolves an `@/x`. A foundation's scope is part " +
            "of its name — `name: '@org/<name>'` in its main.js, which `uniweb register` writes."
        )
      }
      // With no scope the foundation's own types are read as `@/x` too (`siteDeclaredTypes`), so an
      // `@/x` is checked as written: every project's foundation has no scope until its first register.
      if (declared?.types && !declared.types.has(qualifyRef(type, scope))) {
        out.push(
          `${BLUEPRINT_FILE}: \`${at}\` names a type none of this site's foundations declares, so a backend ` +
            'started from this site leaves the line out. Check the name against the foundation\'s data schemas.'
        )
      }
    }
  }
  return out
}

/**
 * `blueprintWarnings` for the site at `siteRoot`, reading what it needs: the file, `site.yml` and the
 * site's foundations — `[]` when it has no blueprint, or one that names no type.
 *
 * @param {string} siteRoot
 * @param {object} [opts]
 * @param {string|null} [opts.scope] - the site's foundation's scope (`siteSelfScope`)
 * @param {string} [opts.foundationDir] - the site's foundation, when a push was handed its folder
 * @param {object} [opts.siteYml] - `site.yml`, already read
 * @param {object|null} [opts.primary] - the site's foundation's schema, already read
 * @param {boolean} [opts.sending] - whether a push is about to send it (`blueprintWarnings`)
 * @returns {Promise<string[]>}
 */
export async function siteBlueprintWarnings(siteRoot, { scope = null, foundationDir, siteYml, primary, sending = false } = {}) {
  const blueprint = readBlueprint(siteRoot)
  if (!isMap(blueprint) || !TYPE_KEYS.some((key) => isMap(blueprint[key]) && Object.keys(blueprint[key]).length)) return []
  const yml = siteYml ?? readSiteYml(siteRoot)
  const declared = await siteDeclaredTypes(siteRoot, yml, { scope, foundationDir, primary })
  return blueprintWarnings(blueprint, { scope, declared, sending })
}

function readSiteYml(siteRoot) {
  try {
    return yaml.load(readFileSync(join(siteRoot, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
  } catch {
    return {}
  }
}

/**
 * The types a site's foundations declare, each in full — the data schemas a backend started from the
 * site installs: its foundation's and each extension's, the `dataSchemas` `register` registers.
 * `types` is null when any of them cannot be read here, since a type the others do not declare may
 * be that one's; `unread` says which, and why.
 *
 * Read from each foundation's source when it is in the project, so it is the foundation a publish
 * would bring along, and from its build when the source does not load.
 *
 * @param {string} siteRoot
 * @param {object} siteYml
 * @param {object} [opts]
 * @param {string|null} [opts.scope] - the site's foundation's scope (`siteSelfScope`)
 * @param {string} [opts.foundationDir] - the site's foundation, when a push was handed its folder
 * @param {object|null} [opts.primary] - the site's foundation's schema, already read by the caller
 *        (the static build's `foundationSections`)
 * @returns {Promise<{ types: Set<string>|null, unread: string[] }>}
 */
export async function siteDeclaredTypes(siteRoot, siteYml, { scope = null, foundationDir, primary } = {}) {
  const types = new Set()
  const unread = []
  const dir = foundationDir ? resolve(foundationDir) : localFoundationDir(siteRoot, siteYml)
  if (!dir) {
    unread.push(`its foundation${typeof siteYml?.foundation === 'string' ? `, \`${siteYml.foundation}\`,` : ''} is not in this project`)
  } else {
    const schema = primary !== undefined && !foundationDir ? primary : await foundationSchema(dir)
    if (!schema) unread.push('its foundation could not be read')
    else for (const ref of Object.keys(schema.dataSchemas || {})) types.add(qualifyRef(ref, scope))
  }
  for (const entry of Array.isArray(siteYml?.extensions) ? siteYml.extensions : []) {
    const declared = typeof entry === 'string' ? entry : isMap(entry) ? entry.url : null
    const name = workspaceExtensionName(declared, siteYml?.base)
    const extDir = name ? findSiteExtension(name, siteRoot) : null
    if (!extDir) {
      unread.push(`the extension${typeof declared === 'string' ? ` \`${declared}\`` : ''} is not in this project`)
      continue
    }
    const schema = await foundationSchema(extDir)
    if (!schema) {
      unread.push(`the extension \`${name}\` could not be read`)
      continue
    }
    const extScope = await foundationScope(extDir)
    for (const ref of Object.keys(schema.dataSchemas || {})) {
      if (ref.startsWith('@/') && !extScope) {
        unread.push(`the extension \`${name}\` has no scope yet`)
        break
      }
      types.add(qualifyRef(ref, extScope))
    }
  }
  return { types: unread.length ? null : types, unread }
}

/** The site's foundation's folder, when it is in the project — else null (a catalog ref, a URL). */
function localFoundationDir(siteRoot, siteYml) {
  if (!siteYml?.foundation) return null
  try {
    const info = detectFoundationType(siteYml.foundation, siteRoot)
    return info?.type === 'local' && info.path ? info.path : null
  } catch {
    return null // a declaration the resolver refuses is the build's to report
  }
}

/** A workspace extension's name, from its declaration — a name, or a site-relative URL — or null. */
function workspaceExtensionName(declared, base) {
  if (typeof declared !== 'string') return null
  if (declared.startsWith('/')) return extensionNameOf(declared, base)?.name ?? null
  return /^[a-z0-9][a-z0-9-]*$/i.test(declared) ? declared : null
}

/** A foundation's schema: from its source, else its build, else null. */
async function foundationSchema(dir) {
  try {
    return await buildSchema(resolveFoundationSrcPath(dir))
  } catch {
    try {
      return JSON.parse(readFileSync(join(dir, 'dist', 'meta', 'schema.json'), 'utf8')) || null
    } catch {
      return null
    }
  }
}

/** The scope in a foundation's name, or null. */
async function foundationScope(dir) {
  try {
    return splitFoundationName((await readFoundationName(dir)).name).scope
  } catch {
    return null
  }
}
