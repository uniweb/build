/**
 * deploy.yml loader
 *
 * Loads a site's deploy.yml (sibling of site.yml) and resolves a target
 * by name. Read-only — never writes. See deploy-config-writer.js for
 * the write path.
 *
 * On-disk shape (spec: kb/framework/reference/deploy-yml.md):
 *   default: production
 *   targets:
 *     production: { host, backend?, ...host-specific config }
 *     preview:    { host, ...host-specific config }
 *   deploys:
 *     production: { at, host, url?, git?, servicesRequest? }
 *   saveDeploys: true
 *
 * ⚠️ `deploys` was `lastDeploy` and `saveDeploys` was `autoSave: off|lastDeploy|full`
 * until 2026-09-20. `full` was "reserved; behaves as lastDeploy" — so the tri-state
 * was already a boolean in practice, and the rename says so. `autoSave` also
 * SOUNDED like it covered the whole file, which it never did.
 *
 * ⚠️ Nothing a backend minted lives here any more. Identity is `sync.json`'s.
 *
 * The CLI and the build pipeline both call resolveTarget() to turn a
 * loaded document + a (possibly null) --target flag into a concrete
 * { host, config } pair to act on. When deploy.yml is absent, the
 * resolver falls back to { host: 'uniweb' } to preserve the historical
 * "bare uniweb deploy" behavior.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { normalizeOrigin } from '../uwx/sync-store.js'

const DEFAULT_TARGET_NAME = 'production'

/**
 * Load and validate deploy.yml from `siteDir`. Returns null when the
 * file is absent (caller decides whether that's an error).
 *
 * @param {string} siteDir
 * @returns {Promise<object|null>}
 */
export async function loadDeployYml(siteDir) {
  const path = join(siteDir, 'deploy.yml')
  if (!existsSync(path)) return null
  const text = await readFile(path, 'utf8')
  const doc = yaml.load(text, YAML_OPTIONS) ?? {}
  return validate(doc, path)
}

/**
 * Resolve a target by name.
 *
 * Precedence: explicit --target flag > deploy.yml's `default:`. With no
 * deploy.yml at all, returns the implicit `{ host: 'uniweb' }` default.
 *
 * @param {object|null} deployYml — output of loadDeployYml(), or null.
 * @param {string|null} requestedTarget — from --target, or null.
 * @returns {{
 *   targetName: string,
 *   host: string,
 *   config: object,
 *   saveDeploys: boolean,
 *   fromFile: boolean,
 * }}
 */
export function resolveTarget(deployYml, requestedTarget) {
  if (!deployYml) {
    if (requestedTarget) {
      throw new Error(
        `--target=${requestedTarget} but no deploy.yml exists. ` +
        'Create deploy.yml first or drop --target.'
      )
    }
    return {
      targetName: DEFAULT_TARGET_NAME,
      host: 'uniweb',
      config: {},
      saveDeploys: true,
      fromFile: false,
    }
  }

  const name = requestedTarget || deployYml.default
  if (!name) {
    throw new Error(
      'deploy.yml declares no `default` and --target was not given. ' +
      'Pass --target=<name> or set `default:` in deploy.yml.'
    )
  }
  const target = deployYml.targets?.[name]
  if (!target) {
    const known = Object.keys(deployYml.targets || {}).sort().join(', ') || '(none)'
    throw new Error(`deploy.yml has no target '${name}'. Known: ${known}.`)
  }
  if (!target.host) {
    throw new Error(`deploy.yml: targets.${name} is missing \`host\`.`)
  }

  const { host, ...config } = target
  return {
    targetName: name,
    host,
    config,
    saveDeploys: deployYml.saveDeploys !== false,
    fromFile: true,
  }
}

/**
 * The target a publish to `origin` records its deploy under.
 *
 * ⭐ **The target follows the backend, never the reverse.** A publish goes to ONE backend,
 * decided before this runs — `--backend`, or the backend the user is logged in to
 * *[Diego, 2026-09-21: "publish should publish to the backend the user logged in to"]*.
 * The default target is only a tie-break, winning when it names that backend too.
 *
 *   1. no deploy.yml → the scaffold: `production`, naming `origin`
 *   2. `host: uniweb` targets naming `origin` → the default one if it is among them,
 *      else the first by name. A target with no `backend:` names `defaultBackend` —
 *      its documented meaning
 *   3. none → a NEW target, named after the backend's host (`uniweb.app`,
 *      `localhost:8080`), `-2`, `-3`… if taken. The caller adds it when it persists.
 *
 * ⛔ Until 2026-09-21 publish always resolved the DEFAULT target, whatever backend it
 * published to: a publish to a second backend recorded over the default target's deploy,
 * and compared its service request against that target's fingerprint.
 *
 * @param {object|null} deployYml - from loadDeployYml
 * @param {string} origin - the backend being published to
 * @param {{ defaultBackend?: string }} [opts]
 * @returns {{ targetName: string, host: 'uniweb', config: object, saveDeploys: boolean,
 *   fromFile: boolean }} `fromFile: false` means the file has no such target yet
 */
export function resolvePublishTarget(deployYml, origin, { defaultBackend } = {}) {
  const key = normalizeOrigin(origin)
  if (!deployYml) {
    return {
      targetName: DEFAULT_TARGET_NAME,
      host: 'uniweb',
      config: { backend: key },
      saveDeploys: true,
      fromFile: false,
    }
  }
  const saveDeploys = deployYml.saveDeploys !== false
  const targets = deployYml.targets || {}
  const naming = Object.keys(targets)
    .filter((name) => {
      const t = targets[name]
      return t && t.host === 'uniweb' && normalizeOrigin(t.backend || defaultBackend) === key
    })
    .sort()
  if (naming.length) {
    const targetName = naming.includes(deployYml.default) ? deployYml.default : naming[0]
    const { host, ...config } = targets[targetName]
    return { targetName, host, config, saveDeploys, fromFile: true }
  }
  let base = 'uniweb'
  try {
    base = new URL(key).host || base
  } catch {
    /* keep the fallback */
  }
  let targetName = base
  for (let i = 2; Object.prototype.hasOwnProperty.call(targets, targetName); i++) {
    targetName = `${base}-${i}`
  }
  return { targetName, host: 'uniweb', config: { backend: key }, saveDeploys, fromFile: false }
}

function validate(doc, path) {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`${path}: top level must be a map.`)
  }
  if (doc.targets !== undefined && (typeof doc.targets !== 'object' || Array.isArray(doc.targets))) {
    throw new Error(`${path}: \`targets\` must be a map.`)
  }
  // ⭐ SEVERAL `host: uniweb` TARGETS ARE LEGAL (2026-09-20). This rejected a second one
  // because a site had a single identity, `site.yml::$uuid`, so two Uniweb targets
  // could not both be coherent. Identity is keyed by backend origin in `sync.json`
  // now: two targets naming DIFFERENT backends are two sites, and two naming the SAME
  // backend are one site shipped twice. The reason is gone, so the rejection is too.
  if (doc.saveDeploys !== undefined && typeof doc.saveDeploys !== 'boolean') {
    throw new Error(`${path}: \`saveDeploys\` must be true or false.`)
  }
  if (doc.default !== undefined && typeof doc.default !== 'string') {
    throw new Error(`${path}: \`default\` must be a string.`)
  }
  if (doc.deploys !== undefined && (typeof doc.deploys !== 'object' || Array.isArray(doc.deploys))) {
    throw new Error(`${path}: \`deploys\` must be a map.`)
  }
  return doc
}
