// File-level diff of two `@uniweb/site-content` documents.
//
// The push staleness gate is ENTITY-grained: a site's whole page tree is one
// entity, so a refusal can only say "the document moved". That leaves the user
// with "pull and lose yours, or force and lose theirs" and no way to judge either.
// This turns the refusal into an account of which units diverged and which side
// moved them.
//
// THE UNIT IS THE FILE, NOT THE PAGE. A site's content is already split one
// section per file, so two people editing different sections — even of the SAME
// page — have not conflicted. Diffing at page granularity reports that as a
// conflict, and a false conflict is not a harmless imprecision: the only moves it
// leaves are pulling (loses their work) or forcing (loses the other side's), so it
// actively pushes people toward the destructive one. Three unit kinds, matching
// exactly what someone would open:
//
//   pages/<route>/page.yml        page metadata (title, slug, section order, …)
//   pages/<route>/<section>.md    one section — including nested `$children`,
//                                 which the projector also writes flat here
//   layout/<section>.md           a layout section
//
// Units are DISJOINT: a page's hash excludes its sections, a section's excludes its
// children, so a change lands in exactly one unit and is never double-reported.
// Naming comes from the projector's own helpers (`pageDirName`,
// `safeStableIdFilename`) rather than a local copy, so a label always names a file
// that really exists.
//
// It needs TWO bases, and that is the non-obvious part.
//
// Our document and the backend's are not byte-comparable renderings of the same
// unit: the backend's copy carries fields we don't emit (`params`,
// `theme_override`, its own `$uuid`) and serializes in its own key order. So a hash
// taken on our side and one taken on theirs differ for a unit NEITHER side touched.
// A single base therefore validates exactly one comparison and silently corrupts
// the other — with a local-representation base every unit looks "changed
// upstream", which is worse than saying nothing.
//
// So each side is compared only against a base in its OWN representation:
//   local  vs localBase   → did WE change it
//   remote vs remoteBase  → did THEY change it
// and local-vs-remote is never compared directly. Both bases are captured at the
// same two moments (a successful push, a pull) from sources already to hand: our
// emitted document, and the backend's `finalized[].document` / the pulled document.
//
// Either base may be missing; the affected side degrades to "unknown" and is
// reported as unattributed rather than guessed at.

import { entityContentHash } from './collections.js'
import { recordStableId, safeStableIdFilename, pageDirName } from './site-project.js'
import { LOCALIZED_FIELD_ASSUMPTION } from './localize.js'

// A unit's own content, with the nested collections that are their own units
// removed — so editing a section never also marks its page (or its parent
// section) as changed.
const ownContent = (record, ...childKeys) => {
  const copy = { ...record }
  for (const k of childKeys) delete copy[k]
  return copy
}

/**
 * Every diffable unit of a site-content document, keyed by the repo-relative path
 * the projector would write it to.
 *
 * Paths use the conventional `pages/` and `layout/` roots. A site that relocates
 * them via `info.paths` still gets stable, unique keys — only the displayed prefix
 * would differ from disk, which is a labelling nicety, not a correctness issue.
 *
 * @returns {Map<string, object>} path → the unit's own record
 */
export function collectSiteUnits(doc, sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale) {
  const units = new Map()

  const walkSections = (sections, dir) => {
    for (const record of sections || []) {
      const id = recordStableId(record)
      // Anonymous and id-less: the projector cannot place it either, so there is
      // no file to name and nothing to attribute.
      if (id) units.set(`${dir}/${safeStableIdFilename(id)}.md`, ownContent(record, '$children'))
      walkSections(record.$children, dir)
    }
  }

  const walkPages = (pages, parentDir, routePrefix) => {
    for (const record of pages || []) {
      const dirName = pageDirName(record, sourceLocale)
      if (!dirName) continue
      const dir = `${parentDir}/${dirName}`
      const ymlName = record.mode === 'folder' ? 'folder.yml' : 'page.yml'
      units.set(`${dir}/${ymlName}`, ownContent(record, 'page_sections', '$children'))
      if (record.mode !== 'folder') walkSections(record.page_sections, dir)
      walkPages(record.$children, dir, routePrefix)
    }
  }

  walkPages(doc?.pages, 'pages')
  walkSections(doc?.layout_sections, 'layout')
  return units
}

/** Per-unit content hashes: `{ <path>: <sha256> }`. */
export function computeUnitHashes(doc, sourceLocale) {
  const out = {}
  for (const [path, record] of collectSiteUnits(doc, sourceLocale)) out[path] = entityContentHash(record)
  return out
}

/**
 * Compare the local and remote site-content documents unit by unit, attributing
 * each side's changes against a base in that side's own representation.
 *
 * @param {object} localDoc  - the document we were about to push
 * @param {object} remoteDoc - the backend's current document
 * @param {object} [bases]
 * @param {Object<string,string>} [bases.local]  - unit hashes of OUR document as of
 *        the last sync. Enables "did we change it".
 * @param {Object<string,string>} [bases.remote] - unit hashes of THEIR document as
 *        of the last sync. Enables "did they change it". Never compare this against
 *        a locally-derived hash.
 * @returns {{
 *   knowsLocal: boolean, knowsRemote: boolean,
 *   changedUpstream: string[], changedLocally: string[], changedBoth: string[],
 *   changedUnattributed: string[],
 *   addedUpstream: string[], addedLocally: string[], identical: string[],
 * }} each list holding repo-relative paths, sorted.
 */
export function diffSiteUnits(localDoc, remoteDoc, bases = {}) {
  const localBase = bases.local || {}
  const remoteBase = bases.remote || {}
  const knowsLocal = Object.keys(localBase).length > 0
  const knowsRemote = Object.keys(remoteBase).length > 0

  const local = collectSiteUnits(localDoc)
  const remote = collectSiteUnits(remoteDoc)

  const out = {
    knowsLocal, knowsRemote,
    changedUpstream: [], changedLocally: [], changedBoth: [], changedUnattributed: [],
    addedUpstream: [], addedLocally: [], identical: [],
  }

  for (const path of new Set([...local.keys(), ...remote.keys()])) {
    const l = local.get(path)
    const r = remote.get(path)
    // Present on one side only. Set membership is representation-independent, so
    // these are sound even with no bases at all — and `addedUpstream` is the
    // dangerous one: forcing does not revert it, it deletes it.
    if (l && !r) { out.addedLocally.push(path); continue }
    if (r && !l) { out.addedUpstream.push(path); continue }

    // Each side against its OWN base. A missing base entry is UNKNOWN, not unchanged.
    const weChanged = knowsLocal && localBase[path] ? entityContentHash(l) !== localBase[path] : null
    const theyChanged = knowsRemote && remoteBase[path] ? entityContentHash(r) !== remoteBase[path] : null

    if (weChanged === false && theyChanged === false) { out.identical.push(path); continue }
    if (weChanged && theyChanged) out.changedBoth.push(path)
    else if (theyChanged) out.changedUpstream.push(path)
    else if (weChanged) out.changedLocally.push(path)
    else if (weChanged === null || theyChanged === null) out.changedUnattributed.push(path)
    else out.identical.push(path)
  }

  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k].sort()
  return out
}

/**
 * Render a diff as the lines a CLI shows after a staleness refusal, ordered by the
 * cost of getting each one wrong. Returns `[]` when there is nothing to say.
 */
export function describeSiteDiff(diff, { limit = 8 } = {}) {
  const lines = []
  // Never let a long list silently truncate into something that reads complete.
  const list = (xs) =>
    xs.length > limit ? `${xs.slice(0, limit).join(', ')} … and ${xs.length - limit} more` : xs.join(', ')

  if (diff.addedUpstream.length) lines.push(`Added upstream — forcing DELETES these: ${list(diff.addedUpstream)}`)
  if (diff.changedBoth.length) lines.push(`Changed on both sides: ${list(diff.changedBoth)}`)
  if (diff.changedUpstream.length) lines.push(`Changed upstream — forcing discards these: ${list(diff.changedUpstream)}`)
  if (diff.changedLocally.length) lines.push(`Changed by you — pulling discards these: ${list(diff.changedLocally)}`)
  if (diff.changedUnattributed.length) lines.push(`Differs, side unknown: ${list(diff.changedUnattributed)}`)
  if (diff.addedLocally.length) lines.push(`Added by you (not upstream yet): ${list(diff.addedLocally)}`)

  // The good news is worth saying: if nothing is contested, the only thing standing
  // between the user and a clean push is taking the other side's work first.
  if (lines.length && !diff.changedBoth.length && !diff.changedUnattributed.length) {
    lines.push('No unit was changed on both sides — pulling should merge cleanly.')
  }
  // Say which half of the attribution is missing rather than under-reporting silently.
  if (lines.length && !diff.knowsRemote) {
    lines.push("No record of the backend's last state, so upstream edits to existing units are not listed.")
  }
  if (lines.length && !diff.knowsLocal) {
    lines.push('No record of your last sync, so your own edits are not listed.')
  }
  return lines
}
