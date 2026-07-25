// Page-level diff of two `@uniweb/site-content` documents.
//
// The push staleness gate is ENTITY-grained: site-content is one entity carrying
// every page, so a refusal can only say "the document moved", never which pages.
// That leaves the user with "pull and lose yours, or force and lose theirs" and no
// way to judge either. This module turns the refusal into a page-level account.
//
// It needs TWO bases, not one, and that is the non-obvious part.
//
// Our document and the backend's are not byte-comparable representations of the
// same page: the backend's copy carries fields ours doesn't emit (`params`,
// `theme_override`, its own `$uuid`) and serializes in its own key order. So a
// hash taken on our side and a hash taken on theirs differ for a page NEITHER side
// touched. A single base therefore validates exactly one comparison and silently
// corrupts the other — with a local-representation base every page looks
// "changed upstream", which is worse than saying nothing.
//
// So each side is compared only against a base in its OWN representation:
//   local  vs localBase   → did WE change it
//   remote vs remoteBase  → did THEY change it
// and local-vs-remote is never compared directly. Both bases are captured at the
// same two moments (a successful push, a pull) from sources already to hand: our
// emitted document, and the backend's own `finalized[].document` / pulled document.
// Per-page hashes, not snapshots — cheap enough to keep on every sync.
//
// Either base may be missing; the affected side degrades to "unknown" and is
// reported as unattributed rather than guessed at.
//
// Why the categories are shaped the way they are: they answer the two questions the
// user actually has at the prompt — "what does pulling cost me" and "what does
// forcing cost them" — rather than describing the diff for its own sake. In
// particular `addedUpstream` is called out because that is the original data-loss
// mode: the backend's reconcile deletes items absent from the package, so forcing
// over a page someone else ADDED removes it outright rather than reverting it.
//
// Pure data in, pure data out: no I/O, no reporting, no opinion about what the
// caller should do with it.

import { entityContentHash } from './collections.js'

// A page's identity across the two sides. `stable_id` is the authored/derived
// stable handle (it survives moves and renames, which is the whole reason it
// exists); the slug is a fallback for a document that predates one.
export function pageIdentity(page) {
  if (!page || typeof page !== 'object') return null
  if (typeof page.stable_id === 'string' && page.stable_id) return page.stable_id
  const slug = page.slug
  if (typeof slug === 'string' && slug) return slug
  // localized `{ lang: value }` — any locale's value is a stable enough fallback
  if (slug && typeof slug === 'object') {
    const first = Object.values(slug).find((v) => typeof v === 'string' && v)
    if (first) return first
  }
  return null
}

// What to show a human. Prefers the route-ish slug over the opaque stable_id.
export function pageLabel(page) {
  const pick = (v) => {
    if (typeof v === 'string' && v) return v
    if (v && typeof v === 'object') return Object.values(v).find((x) => typeof x === 'string' && x) || null
    return null
  }
  return pick(page?.slug) || pick(page?.title) || pageIdentity(page) || '(unnamed)'
}

/**
 * Per-page content hashes of a site-content document: `{ <identity>: <sha256> }`.
 *
 * Uses the same identity-independent hash as the send-only-changed cache, so a
 * `$uuid` the backend back-filled (present on their copy, absent on a never-synced
 * local one) does not make two otherwise-equal pages look different.
 */
export function computePageHashes(doc) {
  const out = {}
  for (const page of doc?.pages || []) {
    const id = pageIdentity(page)
    if (id) out[id] = entityContentHash(page)
  }
  return out
}

/**
 * Compare the local and remote site-content documents, attributing each side's
 * changes against a base in that side's own representation.
 *
 * @param {object} localDoc  - the document we were about to push
 * @param {object} remoteDoc - the backend's current document
 * @param {object} [bases]
 * @param {Object<string,string>} [bases.local]  - page hashes of OUR document as of
 *        the last sync (from our own emit). Enables "did we change it".
 * @param {Object<string,string>} [bases.remote] - page hashes of THEIR document as
 *        of the last sync (from `finalized[].document` or a pull). Enables "did
 *        they change it". Never compare this against a locally-derived hash.
 * @returns {{
 *   knowsLocal: boolean, knowsRemote: boolean,
 *   changedUpstream: string[], changedLocally: string[], changedBoth: string[],
 *   changedUnattributed: string[],
 *   addedUpstream: string[], addedLocally: string[], identical: string[],
 * }} each list holding display labels, sorted.
 */
export function diffSitePages(localDoc, remoteDoc, bases = {}) {
  const localBase = bases.local || {}
  const remoteBase = bases.remote || {}
  const knowsLocal = Object.keys(localBase).length > 0
  const knowsRemote = Object.keys(remoteBase).length > 0

  const byId = (doc) => {
    const m = new Map()
    for (const p of doc?.pages || []) {
      const id = pageIdentity(p)
      if (id) m.set(id, p)
    }
    return m
  }
  const local = byId(localDoc)
  const remote = byId(remoteDoc)

  const out = {
    knowsLocal, knowsRemote,
    changedUpstream: [], changedLocally: [], changedBoth: [], changedUnattributed: [],
    addedUpstream: [], addedLocally: [], identical: [],
  }

  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const l = local.get(id)
    const r = remote.get(id)
    // Present on one side only. Set membership is representation-independent, so
    // these are sound even with no bases at all — and `addedUpstream` is the
    // dangerous one: forcing does not revert it, it deletes it.
    if (l && !r) { out.addedLocally.push(pageLabel(l)); continue }
    if (r && !l) { out.addedUpstream.push(pageLabel(r)); continue }

    // Each side against its OWN base. `undefined` base ⇒ unknown, not unchanged.
    const weChanged = knowsLocal && localBase[id] ? entityContentHash(l) !== localBase[id] : null
    const theyChanged = knowsRemote && remoteBase[id] ? entityContentHash(r) !== remoteBase[id] : null

    if (weChanged === false && theyChanged === false) { out.identical.push(pageLabel(l)); continue }
    if (weChanged && theyChanged) out.changedBoth.push(pageLabel(l))
    else if (theyChanged) out.changedUpstream.push(pageLabel(r))
    else if (weChanged) out.changedLocally.push(pageLabel(l))
    else if (weChanged === null || theyChanged === null) out.changedUnattributed.push(pageLabel(l))
    else out.identical.push(pageLabel(l))
  }

  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k].sort()
  return out
}

/**
 * Render a diff as the lines a CLI shows after a staleness refusal, ordered by
 * what the user most needs to decide. Returns `[]` when there is nothing to say.
 *
 * Deliberately omits `identical` and `changedLocally` from the headline: the first
 * is noise, and the second is the safe case (pulling keeps it — it is only at risk
 * if the user pulls, which the caller mentions separately).
 */
export function describeSiteDiff(diff) {
  const lines = []
  const list = (xs) => xs.join(', ')
  // Ordered by cost of getting it wrong: a deletion first, then the true conflict,
  // then the two one-sided cases.
  if (diff.addedUpstream.length) {
    lines.push(`Added upstream — forcing DELETES these: ${list(diff.addedUpstream)}`)
  }
  if (diff.changedBoth.length) {
    lines.push(`Changed on both sides: ${list(diff.changedBoth)}`)
  }
  if (diff.changedUpstream.length) {
    lines.push(`Changed upstream — forcing discards these: ${list(diff.changedUpstream)}`)
  }
  if (diff.changedLocally.length) {
    lines.push(`Changed by you — pulling discards these: ${list(diff.changedLocally)}`)
  }
  if (diff.changedUnattributed.length) {
    lines.push(`Differs, side unknown: ${list(diff.changedUnattributed)}`)
  }
  if (diff.addedLocally.length) {
    lines.push(`Added by you (not upstream yet): ${list(diff.addedLocally)}`)
  }
  // Say which half of the attribution is missing rather than quietly under-reporting.
  if (lines.length && !diff.knowsRemote) {
    lines.push('No record of the backend\'s last state, so upstream edits to existing pages are not listed.')
  }
  if (lines.length && !diff.knowsLocal) {
    lines.push('No record of your last sync, so your own edits are not listed.')
  }
  return lines
}
