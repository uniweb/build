// Do two renderings of an author's content say the same thing? A pull that changes nothing must leave
// the author's file as they wrote it, and the writer's formatting is not theirs — so a pull compares
// meaning, not text, before it writes.
//
// A leaf, so the writers that compare this way — `project-writer.js` (sections, YAML config, record
// files), `locale-sync.js` (free-form translations) and `records-project.js` (list files) — share one
// rule without importing each other.

import { markdownToProseMirror } from '@uniweb/content-reader'

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** JSON with every object's keys sorted — equal for equal values, whatever the order. */
export const canonicalJson = (value) =>
  JSON.stringify(value, (_, v) =>
    isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
  )

/**
 * Does this markdown parse to `doc`, the way a push parses it?
 *
 * @param {string} markdown - an author's markdown body
 * @param {object} doc - a ProseMirror document
 * @returns {boolean}
 */
export function sameMarkdownDocument(markdown, doc) {
  try {
    return canonicalJson(withoutDefaults(markdownToProseMirror(markdown))) === canonicalJson(withoutDefaults(doc))
  } catch {
    return false
  }
}

// A document without the attributes that only restate a default: an inset's `embedKind: 'visual'`,
// which the parser writes and the pull's re-inlining leaves out (`reinlineInsets`) — so a body holding
// an inset never compared as unchanged (measured 2026-09-26 on the `marketing` template's hero).
function withoutDefaults(doc) {
  return JSON.parse(JSON.stringify(doc), (_, v) => {
    if (v?.type !== 'inset_ref' || v.attrs?.embedKind !== 'visual') return v
    const { embedKind: _visual, ...attrs } = v.attrs
    return { ...v, attrs }
  })
}
