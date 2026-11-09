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
import { parseSchemaRef } from '@uniweb/schemas'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { unresolveSelfScope, bareOrg } from './self-scope.js'
import { writeYamlFile } from './project-writer.js'
import { detectFoundationType } from '../site/foundation-ref.js'
import { findSiteExtension, extensionNameOf } from '../site/workspace-extension.js'
import { resolveFoundationSrcPath } from '../utils/foundation-source-root.js'
import { buildSchema, readFoundationName } from '../schema.js'
import { splitFoundationName } from '../foundation-name.js'

/** The file, beside `site.yml`. */
export const BLUEPRINT_FILE = 'blueprint.yml'

/** What the file holds, in the order a pull writes it. */
export const BLUEPRINT_KEYS = Object.freeze(['signup', 'teams', 'access', 'publicQueries'])

/** The two keys whose entries are types. */
const TYPE_KEYS = Object.freeze(['access', 'publicQueries'])

const SIGNUP = Object.freeze(['open', 'invite_only'])
const LEVELS = Object.freeze(['read', 'edit'])
const ACCESS_KEYS = Object.freeze(['add', 'all'])
const QUERY_KEYS = Object.freeze(['whole', 'where', 'sort', 'limit'])
const TEAM_KEYS = Object.freeze(['label'])

/** In `all`, every member of the home org: the one name there that is not a team. */
const MEMBERS = 'members'

const TEAM_ID = /^[a-z0-9-]+$/

/**
 * YAML 1.1's words for a switch, which js-yaml (YAML 1.2) reads as text, as
 * `services-request.js` says them.
 */
const SWITCH_WORDS = /^(y|yes|on|true|n|no|off|false)$/i
const ON_WORDS = /^(y|yes|on|true)$/i

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** What a value is, in words — for a message that says what was found. */
function described(value) {
  if (value === null || value === undefined) return 'empty'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'string') return value.trim() ? `the text \`${value}\`` : 'empty'
  return `\`${JSON.stringify(value)}\``
}

/** `a`, `b`, `c` and `d` — each in backticks. */
function listed(names) {
  const quoted = names.map((n) => `\`${n}\``)
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

/** Deterministic JSON: object keys sorted at every depth, arrays left in order. */
function stable(value) {
  return JSON.stringify(value ?? null, (_k, v) =>
    isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
  )
}

// ── Reading the file ──────────────────────────────────────────────────────────────

/**
 * `blueprint.yml` as written: a map, `{}` for a file that says nothing yet, or null when there is
 * no file.
 *
 * @param {string} siteRoot - the folder holding `site.yml`
 * @returns {object|null}
 * @throws {Error} when the file is not YAML, or not a map
 */
export function readBlueprint(siteRoot) {
  const file = join(siteRoot, BLUEPRINT_FILE)
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  let value
  try {
    value = yaml.load(text, YAML_OPTIONS)
  } catch (err) {
    throw new Error(`[uniweb] ${BLUEPRINT_FILE}: ${unreadableYaml(err, text)}`)
  }
  if (value === undefined || value === null) return {}
  if (!isMap(value)) {
    throw new Error(`[uniweb] ${BLUEPRINT_FILE} is a map of ${listed(BLUEPRINT_KEYS)} — not ${described(value)}.`)
  }
  return value
}

/**
 * The parser's message, and the fix for the mistake every blueprint invites: a type the foundation
 * names as its own starts with `@`, which YAML reserves, and unquoted it stops the parse with a
 * message that names only the line.
 */
function unreadableYaml(err, text) {
  const first = String(err?.message || err).split('\n')[0].replace(/\.$/, '')
  const line = Number.isInteger(err?.mark?.line) ? text.split('\n')[err.mark.line] ?? '' : ''
  const key = line.match(/(?:^|[\s{,])(@[^\s'":]*)\s*:/)?.[1]
  return key ? `${first}. A key that starts with \`@\` is quoted: \`'${key}':\`.` : `${first}.`
}

// ── Its shape ─────────────────────────────────────────────────────────────────────

/**
 * Everything in a blueprint that its shape does not allow, each said with its key and its fix —
 * `[]` when there is nothing. Only the shape: whether its types are ones the site's foundations
 * declare is `blueprintWarnings`', and never a refusal.
 *
 * @param {*} blueprint - as `readBlueprint` read it
 * @returns {string[]}
 */
export function blueprintProblems(blueprint) {
  if (blueprint === null || blueprint === undefined) return []
  if (!isMap(blueprint)) return [`it is a map of ${listed(BLUEPRINT_KEYS)} — not ${described(blueprint)}.`]
  const found = []

  for (const key of Object.keys(blueprint)) {
    if (!BLUEPRINT_KEYS.includes(key)) {
      found.push(`\`${key}\` is not one of its keys, which are ${listed(BLUEPRINT_KEYS)}.`)
    }
  }

  if ('signup' in blueprint && !SIGNUP.includes(blueprint.signup)) {
    found.push(`\`signup\` is \`open\` or \`invite_only\` — not ${described(blueprint.signup)}.`)
  }

  // The teams a line may name. Every id the file gives counts, even one it refuses, so that one
  // mistake is said once and not again at every line naming it.
  const teams = blueprint.teams
  const teamIds = isMap(teams) ? new Set(Object.keys(teams)) : null
  if (teams !== undefined) found.push(...teamProblems(teams))
  if (blueprint.access !== undefined) found.push(...accessProblems(blueprint.access, teamIds))
  if (blueprint.publicQueries !== undefined) found.push(...publicQueryProblems(blueprint.publicQueries))
  return found
}

function teamProblems(teams) {
  if (!isMap(teams)) {
    return [`\`teams\` is a map of teams by id — \`teams: { sales: { label: Sales } }\` — not ${described(teams)}.`]
  }
  const found = []
  const named = new Map()
  for (const [id, team] of Object.entries(teams)) {
    const at = `teams.${id}`
    if (id === MEMBERS) {
      found.push(`\`${at}\`: \`members\` means every member in \`all\`, so no team has that id.`)
      continue
    }
    if (!TEAM_ID.test(id)) {
      found.push(`\`${at}\`: a team's id is lowercase letters, digits and dashes — its name goes in its \`label\`.`)
      continue
    }
    if (!isMap(team)) {
      found.push(`\`${at}\` is a map — \`${id}: {}\`, or \`${id}: { label: … }\` to name it — not ${described(team)}.`)
      continue
    }
    for (const key of Object.keys(team)) {
      if (!TEAM_KEYS.includes(key)) {
        found.push(`\`${at}.${key}\` is not a team's key: a team has a \`label\`, and starts with no one in it.`)
      }
    }
    if ('label' in team && (typeof team.label !== 'string' || !team.label.trim())) {
      found.push(`\`${at}.label\` is the team's name — not ${described(team.label)}.`)
      continue
    }
    // A team's name is its label, or its id when it has none, and no two teams share one.
    const name = 'label' in team ? team.label : id
    if (named.has(name)) found.push(`\`teams.${named.get(name)}\` and \`${at}\` are both named \`${name}\`: give each team its own.`)
    else named.set(name, id)
  }
  return found
}

function accessProblems(access, teamIds) {
  if (!isMap(access)) {
    return [`\`access\` is a map of types — \`access: { '@/vehicle': { add: [sales] } }\` — not ${described(access)}.`]
  }
  const found = []
  for (const [type, line] of Object.entries(access)) {
    const at = `access.${type}`
    const name = typeNameProblem(at, type)
    if (name) found.push(name)
    if (!isMap(line)) {
      found.push(`\`${at}\` is a map of \`add\` and \`all\` — \`'${type}': { add: open }\` — not ${described(line)}.`)
      continue
    }
    for (const key of Object.keys(line)) {
      if (!ACCESS_KEYS.includes(key)) {
        found.push(`\`${at}.${key}\` is not one of a type's keys: \`add\`, who adds its entries, and \`all\`, who reads or edits every one.`)
      }
    }
    if ('add' in line) found.push(...addProblems(`${at}.add`, line.add, teamIds))
    if ('all' in line) found.push(...allProblems(`${at}.all`, line.all, teamIds))
  }
  return found
}

function addProblems(at, add, teamIds) {
  if (add === 'open') return []
  if (!Array.isArray(add)) {
    return [`\`${at}\` is \`open\`, a list of teams, or \`[]\` for none — not ${described(add)}.`]
  }
  const found = []
  for (const team of add) {
    if (team === MEMBERS) {
      found.push(`\`${at}\` names \`members\`: to let every signed-in account add entries of the type, write \`add: open\`.`)
    } else if (typeof team !== 'string') {
      found.push(`\`${at}\` lists ${described(team)}, which is not a team's id.`)
    } else if (teamIds && !teamIds.has(team)) {
      found.push(`\`${at}\` names \`${team}\`, which is not one of \`teams\`.`)
    }
  }
  return found
}

function allProblems(at, all, teamIds) {
  if (!isMap(all)) {
    return [`\`${at}\` is a map of teams, or \`members\`, to \`read\` or \`edit\` — \`all: { sales: edit }\` — not ${described(all)}.`]
  }
  const found = []
  for (const [who, level] of Object.entries(all)) {
    if (who !== MEMBERS && teamIds && !teamIds.has(who)) {
      found.push(`\`${at}.${who}\` is neither one of \`teams\` nor \`members\`, every member.`)
    }
    if (!LEVELS.includes(level)) found.push(levelProblem(`${at}.${who}`, level))
  }
  return found
}

function levelProblem(at, level) {
  if (level === 'view') return `\`${at}\` is \`view\`: the level that reads every entry is \`read\`.`
  if (level === 'admin') return `\`${at}\` is \`admin\`, which deletes, and a blueprint gives \`read\` or \`edit\`.`
  return `\`${at}\` is \`read\` or \`edit\` — not ${described(level)}.`
}

function publicQueryProblems(queries) {
  if (!isMap(queries)) {
    return [`\`publicQueries\` is a map of types — \`publicQueries: { '@/vehicle': { whole: false } }\` — not ${described(queries)}.`]
  }
  const found = []
  for (const [type, entry] of Object.entries(queries)) {
    const at = `publicQueries.${type}`
    const name = typeNameProblem(at, type)
    if (name) found.push(name)
    if (!isMap(entry)) {
      found.push(`\`${at}\` is a map that says at least \`whole\` — \`'${type}': { whole: false }\` — not ${described(entry)}.`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!QUERY_KEYS.includes(key)) found.push(`\`${at}.${key}\` is not one of a public query's keys, which are ${listed(QUERY_KEYS)}.`)
    }
    // ⭐ STATED EVERY TIME: a public query that leaves `whole` out serves every entry of the type
    // whole, so the file asks for the choice the admin app's screen asks for.
    if (!('whole' in entry)) {
      found.push(
        `\`${at}\` says nothing of \`whole\`: write \`whole: false\` to let visitors read the entries' briefs, ` +
          'or `whole: true` for whole entries. Left out, every entry is served whole.'
      )
    } else if (typeof entry.whole !== 'boolean') {
      found.push(
        typeof entry.whole === 'string' && SWITCH_WORDS.test(entry.whole.trim())
          ? `\`${at}.whole\` is the text \`${entry.whole}\`, not true or false — YAML reads yes, no, on and off as words. Write \`whole: ${ON_WORDS.test(entry.whole.trim())}\`.`
          : `\`${at}.whole\` is true or false — not ${described(entry.whole)}.`
      )
    }
  }
  return found
}

/** A type's name is `@/x` or `@scope/x` (`parseSchemaRef`), or null. */
function typeNameProblem(at, type) {
  try {
    parseSchemaRef(type)
    return null
  } catch {
    const bare = String(type).replace(/^@?\/?/, '')
    return `\`${at}\` names no type: one of the foundation's own is \`'@/${bare}'\`, and any other is named in full, \`'@scope/${bare}'\`.`
  }
}

/**
 * Whether `site.yml` names the `backend` service — on, off, or settings. The row a blueprint rides.
 *
 * @param {object} siteYml
 * @returns {boolean}
 */
function namesBackend(siteYml) {
  const services = siteYml?.services
  return isMap(services) && services.backend !== undefined && services.backend !== null
}

/**
 * Stop on a blueprint neither a build nor a push can take — beside `refuseUnreadableServices`.
 *
 * ⭐ A MALFORMED BLUEPRINT REFUSES THE WHOLE PUSH, content included: the backend refuses a push
 * whose `backend` row it cannot read, and the author who can fix the line is at the keyboard.
 *
 * Also refused, since the two files must agree:
 *
 *   - a `blueprint:` in `site.yml::services.backend` — the blueprint's one home is its file, and a
 *     push would send that one with its types unqualified;
 *   - a blueprint beside a `site.yml` that names no `backend` service: it rides that row, so with
 *     none it would go nowhere. ⚠️ A `backend` that is off still carries it — `backend: false`, or
 *     `enabled: false` — as the row does: a pull writes an off row's blueprint back, and turning the
 *     backend on again in the app starts from it.
 *
 * @param {object|null} blueprint - as `readBlueprint` read it
 * @param {{ siteYml?: object, where?: string }} [opts]
 * @throws {Error} naming each key and its fix
 */
export function refuseUnreadableBlueprint(blueprint, { siteYml = null, where = BLUEPRINT_FILE } = {}) {
  const inSite = siteYml?.services?.backend
  if (isMap(inSite) && inSite.blueprint !== undefined) {
    throw new Error(
      '[uniweb] site.yml: `services.backend.blueprint` is not read from site.yml — a site\'s blueprint is ' +
        `\`${BLUEPRINT_FILE}\`, beside it. Move the block there, as the file's whole content.`
    )
  }
  if (blueprint === null || blueprint === undefined) return
  const found = blueprintProblems(blueprint)
  if (found.length) {
    throw new Error(
      found.length === 1
        ? `[uniweb] ${where}: ${found[0]}`
        : `[uniweb] ${where} has lines a backend cannot take:\n${found.map((f) => `  - ${f}`).join('\n')}`
    )
  }
  if (siteYml && !namesBackend(siteYml)) {
    throw new Error(
      `[uniweb] ${where} says how a backend started from this site begins, and site.yml asks for none. ` +
        'Add `backend: true` under `services:` in site.yml, or remove the file.'
    )
  }
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
    return stable(blueprintForWire(local, scope)) === stable(wire)
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
 *   - an `@/x` a push cannot name in full, because the foundation has no scope yet.
 *
 * @param {object|null} blueprint - a checked blueprint (`refuseUnreadableBlueprint`)
 * @param {object} p
 * @param {string|null} p.scope - the scope the site's `@/x` resolve into
 * @param {{ types: Set<string>|null }} p.declared - what `siteDeclaredTypes` read
 * @returns {string[]}
 */
export function blueprintWarnings(blueprint, { scope, declared }) {
  if (!isMap(blueprint)) return []
  const out = []
  const scoped = Boolean(bareOrg(scope))
  for (const key of TYPE_KEYS) {
    if (!isMap(blueprint[key])) continue
    for (const type of Object.keys(blueprint[key])) {
      const at = `${key}.${type}`
      if (!scoped && type.startsWith('@/')) {
        out.push(
          `${BLUEPRINT_FILE}: \`${at}\` is the foundation's own type, and the foundation has no scope yet, ` +
            "so a push sends it as written — the backend never resolves an `@/x`. A foundation's scope is part " +
            "of its name — `name: '@org/<name>'` in its main.js, which `uniweb register` writes."
        )
        continue
      }
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
 * @returns {Promise<string[]>}
 */
export async function siteBlueprintWarnings(siteRoot, { scope = null, foundationDir, siteYml, primary } = {}) {
  const blueprint = readBlueprint(siteRoot)
  if (!isMap(blueprint) || !TYPE_KEYS.some((key) => isMap(blueprint[key]) && Object.keys(blueprint[key]).length)) return []
  const yml = siteYml ?? readSiteYml(siteRoot)
  const declared = await siteDeclaredTypes(siteRoot, yml, { scope, foundationDir, primary })
  return blueprintWarnings(blueprint, { scope, declared })
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
