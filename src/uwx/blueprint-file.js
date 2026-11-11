/**
 * `blueprint.yml` read and checked — the file half of a site's backend blueprint (`./blueprint.js`
 * has the rest: the wire, the pull, and what a backend would leave out).
 *
 * ⭐ ITS OWN MODULE, AND A LIGHT ONE, so `uniweb dev`'s mock can read the file without loading the
 * push and pull: YAML and the shape, nothing more. Exported as `@uniweb/build/blueprint`:
 *
 * ```js
 * import { readBlueprint } from '@uniweb/build/blueprint'
 * const blueprint = readBlueprint(siteRoot)   // a map, {} for an empty file, or null
 * ```
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { parseSchemaRef } from '@uniweb/schemas/format'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'

/** The file, beside `site.yml`. */
export const BLUEPRINT_FILE = 'blueprint.yml'

/** What the file holds, in the order a pull writes it. */
export const BLUEPRINT_KEYS = Object.freeze(['signup', 'teams', 'access', 'publicQueries', 'integrations'])

/** The two keys whose entries are types. */
export const TYPE_KEYS = Object.freeze(['access', 'publicQueries'])

const SIGNUP = Object.freeze(['open', 'invite_only'])
const LEVELS = Object.freeze(['read', 'edit'])
const ACCESS_KEYS = Object.freeze(['add', 'all'])
const QUERY_KEYS = Object.freeze(['whole', 'where', 'sort', 'limit'])
const TEAM_KEYS = Object.freeze(['label'])

/**
 * An integration line, as a backend takes it. Refused here exactly as a backend refuses them, and no
 * more: a line this takes, a backend takes.
 */
const INTEGRATION_KEYS = Object.freeze(['label', 'mapping', 'channel', 'trigger', 'filter', 'enabled', 'reply', 'reply_about'])
/** The one channel whose endpoint answers, so the one a `reply` mapping may sit on. */
const REPLYING = 'http'
/** `reply_about`: a field of the reply's type, `section.field`. */
const SECTION_FIELD = /^[^.\s]+\.[^.\s]+$/
const CHANNELS = Object.freeze(['file', 'feed', 'email', 'http'])
const TRIGGERS = Object.freeze(['manual', 'on_fetch', 'on_create', 'on_match', 'on_change'])
/** Each channel → the triggers it pairs with. */
const PAIRS = Object.freeze({
  file: ['manual'],
  feed: ['on_fetch'],
  email: ['on_create', 'on_match', 'on_change', 'manual'],
  http: ['on_create', 'on_match', 'on_change', 'manual'],
})
/** The channels a line may switch on with `enabled: true`. */
const ENABLEABLE = Object.freeze(['file', 'feed'])

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
  if (blueprint.integrations !== undefined) found.push(...integrationProblems(blueprint.integrations))
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

function integrationProblems(integrations) {
  if (!isMap(integrations)) {
    return [
      `\`integrations\` is a map of integrations by id — \`integrations: { meta-catalog: { mapping: '@/vehicle-to-meta', channel: feed, trigger: on_fetch } }\` — not ${described(integrations)}.`,
    ]
  }
  const found = []
  for (const [id, line] of Object.entries(integrations)) {
    const at = `integrations.${id}`
    if (!TEAM_ID.test(id)) {
      found.push(`\`${at}\`: an integration's id is lowercase letters, digits and dashes — its name goes in its \`label\`.`)
      continue
    }
    if (!isMap(line)) {
      found.push(`\`${at}\` is a map of ${listed(INTEGRATION_KEYS)} — not ${described(line)}.`)
      continue
    }
    for (const key of Object.keys(line)) {
      if (!INTEGRATION_KEYS.includes(key)) {
        found.push(
          `\`${at}.${key}\` is not one of an integration's keys, which are ${listed(INTEGRATION_KEYS)}. ` +
            'An address, a URL or a key is the owner\'s to give in the admin app, never the file\'s.'
        )
      }
    }
    if ('label' in line && (typeof line.label !== 'string' || !line.label.trim())) {
      found.push(`\`${at}.label\` is the integration's name — not ${described(line.label)}.`)
    }
    if (!('mapping' in line)) {
      found.push(`\`${at}\` names no \`mapping\`: one of the foundation's own is \`mapping: '@/<name>'\`.`)
    } else {
      const name = refNameProblem(`${at}.mapping`, line.mapping, 'mapping')
      if (name) found.push(name)
    }
    const channelOk = CHANNELS.includes(line.channel)
    const triggerOk = TRIGGERS.includes(line.trigger)
    if (!channelOk) found.push(`\`${at}.channel\` is one of ${listed(CHANNELS)} — not ${described(line.channel)}.`)
    if (!triggerOk) found.push(`\`${at}.trigger\` is one of ${listed(TRIGGERS)} — not ${described(line.trigger)}.`)
    if (channelOk && triggerOk && !PAIRS[line.channel].includes(line.trigger)) {
      found.push(`\`${at}\`: a \`${line.channel}\` integration's trigger is one of ${listed(PAIRS[line.channel])} — not \`${line.trigger}\`.`)
    }
    if ('reply' in line) {
      const name = refNameProblem(`${at}.reply`, line.reply, 'mapping')
      if (name) found.push(name)
      if (channelOk && line.channel !== REPLYING) {
        found.push(`\`${at}.reply\`: only an \`${REPLYING}\` integration is answered, so only one takes a \`reply\` — not a \`${line.channel}\` one.`)
      }
    }
    if ('reply_about' in line) {
      if (!('reply' in line)) {
        found.push(`\`${at}.reply_about\` names a field of the reply's type, so it goes with a \`reply\` mapping — the line has none.`)
      } else if (typeof line.reply_about !== 'string' || !SECTION_FIELD.test(line.reply_about)) {
        found.push(`\`${at}.reply_about\` is a field of the reply's type, \`section.field\` — \`identity.submission\` — not ${described(line.reply_about)}.`)
      }
    }
    if ('filter' in line && !isMap(line.filter)) {
      found.push(`\`${at}.filter\` is a map — \`filter: { where: { status: sold } }\` — not ${described(line.filter)}.`)
    }
    if ('enabled' in line) {
      if (line.enabled !== true) {
        found.push(
          typeof line.enabled === 'string' && SWITCH_WORDS.test(line.enabled.trim())
            ? `\`${at}.enabled\` is the text \`${line.enabled}\` — YAML reads yes, no, on and off as words. Write \`enabled: true\`, or leave it out.`
            : `\`${at}.enabled\` is \`true\`, or left out — not ${described(line.enabled)}.`
        )
      } else if (channelOk && !ENABLEABLE.includes(line.channel)) {
        found.push(
          `\`${at}.enabled\`: a \`${line.channel}\` integration is switched on by its owner in the admin app, ` +
            'once its address is given. Leave `enabled` out.'
        )
      }
    }
  }
  return found
}

/** A name that must be `@/x` or `@scope/x`, or null. */
function refNameProblem(at, ref, what) {
  try {
    parseSchemaRef(ref)
    return null
  } catch {
    const bare = String(ref).replace(/^@?\/?/, '')
    return `\`${at}\` names no ${what}: one of the foundation's own is \`'@/${bare}'\`, and any other is named in full, \`'@scope/${bare}'\`.`
  }
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
