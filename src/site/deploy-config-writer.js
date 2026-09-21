/**
 * deploy.yml writer
 *
 * Updates the deploys.<target> block of a site's deploy.yml without
 * reformatting the rest of the file. Uses the eemeli/yaml Document API
 * because js-yaml does not preserve comments on round-trip — the writer
 * must not destroy a developer's comments on the targets:/saveDeploys:
 * regions of the file.
 *
 * This is the only place in @uniweb/build that depends on `yaml`. The
 * loader (deploy-config.js) stays on js-yaml for read-only ingestion.
 *
 * `saveDeploys: false` (or `--no-save`) makes this a no-op; otherwise it
 * touches ONLY deploys.<targetName>. ⚠️ It was `autoSave: off|lastDeploy|full`
 * until 2026-09-20, and `full` was reserved and behaved as `lastDeploy` — a
 * boolean wearing a tri-state.
 *
 * First-deploy path: when deploy.yml does not exist, writes a fresh
 * file scaffolded with `default:`, a single entry under `targets:`, and
 * `saveDeploys: true`. This is the only code path that writes the
 * config region.
 *
 * And two removals, for `uniweb forget`: `forgetDeploys` drops the records one
 * backend wrote and keeps every target; `forgetDeployYml` deletes the file, for a
 * copy that is to become a new project.
 */

import { readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Document, parseDocument, isMap } from 'yaml'
import { normalizeOrigin } from '../uwx/sync-store.js'

// The header every generated deploy.yml carries. It has to answer the question
// a reader has while looking AT the file — who wrote this, and may I edit it —
// because that is where the question gets asked, not in the docs.
//
// The previous wording opened "operational config ... edit `targets:` freely",
// which reads as a file you are expected to author with one auto-managed block
// inside it. It cost a real reader an afternoon: they went looking for what to
// write under `targets:` for a site that had never deployed, when the answer is
// that the first deploy writes it.
const SCAFFOLD_HEADER = [
  ' deploy.yml — written by `uniweb deploy` / `uniweb publish`.',
  '',
  ' You do not create this file. The first successful deploy does, recording the',
  ' target you picked and what happened. Later deploys rewrite only `deploys:`',
  ' and leave the rest — including your comments — alone.',
  '',
  ' Safe to commit; no credentials live here. Host credentials come from the',
  ' environment.',
  '',
  '   default:     which target is used when none is named',
  '   targets:     where this site ships. Edit to change the destination, or add',
  '                a target and pick it with `--target <name>`',
  '   deploys:     what each target\'s last deploy did. A record, not a setting.',
  '                `publish` reads one field back — a fingerprint of the service',
  '                request it last sent — so deleting it only means the next',
  '                publish re-sends that request',
  '   saveDeploys: false to stop recording deploys',
  '',
  ' Which site this is on each backend lives in sync.json, not here.',
].join('\n')

/**
 * Update or create deploy.yml with a fresh deploys.<target> entry.
 *
 * @param {string} siteDir
 * @param {object} opts
 * @param {string} opts.targetName       e.g. 'production'
 * @param {object} [opts.targetConfig]   { host, ...host-specific }; only
 *                                       used on first-deploy scaffold.
 * @param {object} opts.lastDeploy       { at, url, foundation, runtime,
 *                                          artifactSha, ... }
 * @param {boolean} opts.saveDeploys - false makes this a no-op
 * @returns {Promise<{ created: boolean, path: string } | null>}
 *          null when saveDeploys is false (no-op).
 */
export async function recordLastDeploy(siteDir, opts) {
  const { targetName, targetConfig, lastDeploy, saveDeploys } = opts

  if (saveDeploys === false) return null

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

  // Touch ONLY deploys.<targetName>. Never reach into targets/default/saveDeploys.
  let deploysNode = doc.get('deploys', true)
  if (!isMap(deploysNode)) {
    doc.set('deploys', { [targetName]: lastDeploy })
  } else {
    deploysNode.set(targetName, lastDeploy)
  }

  await writeFile(path, doc.toString(), 'utf8')
  return { created: false, path }
}

function scaffold({ targetName, targetConfig, lastDeploy }) {
  const doc = new Document({
    default: targetName,
    targets: { [targetName]: targetConfig },
    deploys: { [targetName]: lastDeploy },
    saveDeploys: true,
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
 *     default, saveDeploys: true. No deploys block (no deploy
 *     has happened yet).
 *   - File exists: merge targetConfig into targets.<targetName>
 *     (overlapping keys overwritten, other keys preserved). Never
 *     touches `default`, `saveDeploys`, `deploys`, or other targets,
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
      saveDeploys: true,
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

/**
 * Remove the deploy records one backend wrote — `uniweb forget --backend <url>`.
 *
 * A record belongs to the backend it names: every publish writes
 * `deploys.<target>.backend`. A record naming none falls back to its target's
 * `backend:`, which only a `host: uniweb` target has — so no other host's history
 * can match, and a record that names no backend anywhere is left alone rather than
 * guessed at.
 *
 * ⛔ **`targets:` stays.** A target is a CHOICE of where to ship, not something a
 * backend told us — the spec's own line between this file and `sync.json`. After
 * the forget, the next publish there simply creates a new site.
 *
 * Why the records go at all: each names the forgotten site (`siteUuid`, `url`), and
 * its request fingerprint describes what was sent to THAT site. Kept, they would
 * sit beside a target that now publishes somewhere else entirely.
 *
 * @param {string} siteDir
 * @param {string} origin
 * @returns {Promise<string[]>} the target names whose record was removed, sorted
 * @throws when deploy.yml exists and does not parse — the caller decides whether
 *   that blocks anything; this does not rewrite a file it could not read
 */
export async function forgetDeploys(siteDir, origin) {
  const key = normalizeOrigin(origin)
  const path = join(siteDir, 'deploy.yml')
  if (!key || !existsSync(path)) return []

  const doc = parseDocument(await readFile(path, 'utf8'))
  if (doc.errors.length) {
    throw new Error(`deploy.yml did not parse: ${doc.errors[0].message.split('\n')[0]}`)
  }
  const deploysNode = doc.get('deploys', true)
  if (!isMap(deploysNode)) return []

  const js = doc.toJS() || {}
  const removed = []
  for (const [name, record] of Object.entries(js.deploys || {})) {
    const target = js.targets?.[name]
    const named =
      record?.backend ?? (target?.host === 'uniweb' ? target?.backend : undefined)
    if (normalizeOrigin(named) === key) removed.push(name)
  }
  if (!removed.length) return []

  for (const name of removed) deploysNode.delete(name)
  // An empty `deploys: {}` says nothing and would be the only thing left of the
  // backend in this file.
  if (!deploysNode.items.length) doc.delete('deploys')
  await writeFile(path, doc.toString(), 'utf8')
  return removed.sort()
}

/**
 * Delete deploy.yml outright — `uniweb forget --all`, for a copy that is to become a
 * new project.
 *
 * ⭐ **The targets go too, not just the records** *[Diego, 2026-09-21: "if it's for
 * duplicating a site project and making a new site from it, … the whole deploy.yml
 * file has to be deleted"]*. They name the ORIGINAL's destinations — its Pages
 * project, its bucket, its domain — so a deploy from the copy would overwrite the
 * original there. The copy's first deploy writes a fresh file.
 *
 * @param {string} siteDir
 * @returns {Promise<string[]|null>} the target names it held, or null when there
 *   was no file. A file that does not parse is removed all the same and reports `[]`.
 */
export async function forgetDeployYml(siteDir) {
  const path = join(siteDir, 'deploy.yml')
  if (!existsSync(path)) return null
  let names = []
  try {
    const doc = parseDocument(await readFile(path, 'utf8'))
    if (!doc.errors.length) names = Object.keys(doc.toJS()?.targets || {}).sort()
  } catch {
    /* unreadable — still the original's, still removed */
  }
  await unlink(path)
  return names
}
