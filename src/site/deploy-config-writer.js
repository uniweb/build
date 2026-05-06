/**
 * deploy.yml writer
 *
 * Updates the lastDeploy.<target> block of a site's deploy.yml without
 * reformatting the rest of the file. Uses the eemeli/yaml Document API
 * because js-yaml does not preserve comments on round-trip — the writer
 * must not destroy a developer's comments on the targets:/autoSave:
 * regions of the file.
 *
 * This is the only place in @uniweb/build that depends on `yaml`. The
 * loader (deploy-config.js) stays on js-yaml for read-only ingestion.
 *
 * Auto-save semantics:
 *   - 'off'        : no-op (CI / `--no-save`)
 *   - 'lastDeploy' : touch ONLY lastDeploy.<targetName>
 *   - 'full'       : reserved; behaves as 'lastDeploy' for now
 *
 * First-deploy path: when deploy.yml does not exist, writes a fresh
 * file scaffolded with `default:`, a single entry under `targets:`, and
 * `autoSave: lastDeploy`. This is the only code path that writes the
 * config region.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Document, parseDocument, isMap } from 'yaml'

const SCAFFOLD_HEADER = [
  ' deploy.yml — operational config and last-deploy memory for this site.',
  ' Safe to commit. The `lastDeploy:` block is auto-managed by `uniweb deploy`;',
  ' edit `targets:` freely. See: kb/framework/plans/static-host-deploy-adapters.md',
].join('\n')

/**
 * Update or create deploy.yml with a fresh lastDeploy.<target> entry.
 *
 * @param {string} siteDir
 * @param {object} opts
 * @param {string} opts.targetName       e.g. 'production'
 * @param {object} [opts.targetConfig]   { host, ...host-specific }; only
 *                                       used on first-deploy scaffold.
 * @param {object} opts.lastDeploy       { at, url, foundation, runtime,
 *                                          artifactSha, ... }
 * @param {'off'|'lastDeploy'|'full'} opts.autoSave
 * @returns {Promise<{ created: boolean, path: string } | null>}
 *          null when autoSave is 'off' (no-op).
 */
export async function recordLastDeploy(siteDir, opts) {
  const { targetName, targetConfig, lastDeploy, autoSave } = opts

  if (autoSave === 'off') return null

  const path = join(siteDir, 'deploy.yml')

  if (!existsSync(path)) {
    if (!targetConfig || !targetConfig.host) {
      // First-deploy scaffold needs at least the host. The CLI is
      // responsible for handing us one.
      throw new Error(
        'recordLastDeploy: first-deploy scaffold requires opts.targetConfig.host.'
      )
    }
    const doc = scaffold({ targetName, targetConfig, lastDeploy })
    await writeFile(path, doc.toString(), 'utf8')
    return { created: true, path }
  }

  const text = await readFile(path, 'utf8')
  const doc = parseDocument(text)

  // Touch ONLY lastDeploy.<targetName>. Never reach into targets/default/autoSave.
  let lastDeployNode = doc.get('lastDeploy', true)
  if (!isMap(lastDeployNode)) {
    doc.set('lastDeploy', { [targetName]: lastDeploy })
  } else {
    lastDeployNode.set(targetName, lastDeploy)
  }

  await writeFile(path, doc.toString(), 'utf8')
  return { created: false, path }
}

function scaffold({ targetName, targetConfig, lastDeploy }) {
  const doc = new Document({
    default: targetName,
    targets: { [targetName]: targetConfig },
    autoSave: 'lastDeploy',
    lastDeploy: { [targetName]: lastDeploy },
  })
  doc.commentBefore = SCAFFOLD_HEADER
  return doc
}

/**
 * Update or create deploy.yml with a target's adapter-specific config.
 * Distinct from recordLastDeploy: that one records *deploy memory*
 * (lastDeploy.<target>); this one records *adapter intent* (targets.<target>).
 *
 * Used at scaffold time by `uniweb add ci` so a target's config (host
 * + adapter-specific fields like `domain`, `bucket`, etc.) is captured
 * without waiting for a first deploy. github-pages deploys via GHA, not
 * via the CLI, so its target config would otherwise never reach deploy.yml.
 *
 * @param {string} siteDir
 * @param {object} opts
 * @param {string} opts.targetName       e.g. 'github-pages'
 * @param {object} opts.targetConfig     { host, ...adapter-specific }
 * @returns {Promise<{ created: boolean, path: string, action: 'scaffold'|'merge' }>}
 *
 * Behavior:
 *   - File missing: scaffold a fresh file with this target, set as
 *     default, autoSave: lastDeploy. No lastDeploy block (no deploy
 *     has happened yet).
 *   - File exists: merge targetConfig into targets.<targetName>
 *     (overlapping keys overwritten, other keys preserved). Never
 *     touches `default`, `autoSave`, `lastDeploy`, or other targets,
 *     so adding a CI workflow to a project that already deploys
 *     elsewhere doesn't change its deploy semantics.
 */
export async function recordTarget(siteDir, opts) {
  const { targetName, targetConfig } = opts

  if (!targetName || typeof targetName !== 'string') {
    throw new Error('recordTarget: opts.targetName is required.')
  }
  if (!targetConfig || !targetConfig.host) {
    throw new Error('recordTarget: opts.targetConfig.host is required.')
  }

  const path = join(siteDir, 'deploy.yml')

  if (!existsSync(path)) {
    const doc = new Document({
      default: targetName,
      targets: { [targetName]: targetConfig },
      autoSave: 'lastDeploy',
    })
    doc.commentBefore = SCAFFOLD_HEADER
    await writeFile(path, doc.toString(), 'utf8')
    return { created: true, path, action: 'scaffold' }
  }

  const text = await readFile(path, 'utf8')
  const doc = parseDocument(text)

  // Merge into targets.<targetName>, creating intermediate nodes as
  // needed. We avoid `doc.set('targets', { ... })` because that would
  // replace any sibling target the user authored.
  let targetsNode = doc.get('targets', true)
  if (!isMap(targetsNode)) {
    doc.set('targets', { [targetName]: targetConfig })
  } else {
    let existing = targetsNode.get(targetName, true)
    if (!isMap(existing)) {
      targetsNode.set(targetName, targetConfig)
    } else {
      // Per-key merge: overwrite keys we're setting, leave others alone.
      // Preserves any hand-authored fields the user added.
      for (const [k, v] of Object.entries(targetConfig)) {
        existing.set(k, v)
      }
    }
  }

  await writeFile(path, doc.toString(), 'utf8')
  return { created: false, path, action: 'merge' }
}
