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
