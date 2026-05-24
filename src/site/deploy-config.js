/**
 * deploy.yml loader
 *
 * Loads a site's deploy.yml (sibling of site.yml) and resolves a target
 * by name. Read-only — never writes. See deploy-config-writer.js for
 * the write path.
 *
 * On-disk shape:
 *   default: production
 *   targets:
 *     production: { host, ...host-specific config }
 *     preview:    { host, ...host-specific config }
 *   autoSave: lastDeploy | off | full
 *   lastDeploy:
 *     production: { at, url, foundation, runtime, artifactSha, ... }
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

const DEFAULT_TARGET_NAME = 'production'
const VALID_AUTOSAVE = new Set(['off', 'lastDeploy', 'full'])

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
  const doc = yaml.load(text) ?? {}
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
 *   autoSave: 'off'|'lastDeploy'|'full',
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
      autoSave: 'lastDeploy',
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
    autoSave: deployYml.autoSave || 'lastDeploy',
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
  if (doc.autoSave !== undefined && !VALID_AUTOSAVE.has(doc.autoSave)) {
    throw new Error(
      `${path}: \`autoSave\` must be one of: ${[...VALID_AUTOSAVE].join(', ')}.`
    )
  }
  if (doc.default !== undefined && typeof doc.default !== 'string') {
    throw new Error(`${path}: \`default\` must be a string.`)
  }
  if (doc.lastDeploy !== undefined && (typeof doc.lastDeploy !== 'object' || Array.isArray(doc.lastDeploy))) {
    throw new Error(`${path}: \`lastDeploy\` must be a map.`)
  }
  return doc
}
