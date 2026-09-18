/**
 * Hash utilities for i18n translation units
 */

import { createHash } from 'node:crypto'

/**
 * Compute an 8-character hash for translation unit identification
 * @param {string} text - Source text to hash
 * @returns {string} 8-character hex hash
 */
export function computeHash(text) {
  const normalized = normalizeText(text)
  return createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 8)
}

/**
 * Normalize text for consistent hashing
 * - Trim whitespace
 * - Normalize internal whitespace to single spaces
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return ''
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * Strip inline mark tags for hashing: "<1>text</1>" → "text"
 *
 * VESTIGIAL BUT LIVE. `<N>` tags were the pre-2026-06-24 mark-preservation scheme:
 * a unit's source carried numbered tags and the merge re-applied the source's marks
 * to the matching spans positionally. Whole-element keying replaced it (`d12d594`) —
 * a translation VALUE is now inline markdown and the merge re-parses it, so nothing
 * emits a `<N>` tag any more.
 *
 * ⛔ This stays anyway, because it runs on the HASH path: a manifest written before
 * that change still holds tagged sources, and stripping keeps their keys matching
 * what extraction produces today. Removing it would silently orphan those
 * translations. The tag PARSER that went with it (`parseInlineTags`) had no callers
 * and was deleted 2026-09-18; it was the only thing in the codebase that still looked
 * like a live mark-preservation convention, which cost a peer lane a day of hunting
 * for the placeholder syntax it implied.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInlineTags(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/<\/?(\d+)>/g, '')
}
