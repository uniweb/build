/**
 * Hash utilities for i18n translation units
 */

import { createHash } from 'crypto'

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
 * Used to keep hash keys stable regardless of mark tagging.
 * @param {string} text
 * @returns {string}
 */
export function stripInlineTags(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/<\/?(\d+)>/g, '')
}

/**
 * Parse tagged translation string into segments.
 * "plain <1>marked</1> more" →
 *   { segments: [{ text: "plain " }, { text: "marked", markIndex: 0 }, { text: " more" }], hasMarks: true }
 *
 * Tag numbers are 1-based in the string, markIndex is 0-based in the result.
 * @param {string} text
 * @returns {{ segments: Array<{ text: string, markIndex?: number }>, hasMarks: boolean }}
 */
export function parseInlineTags(text) {
  const regex = /<(\d+)>([\s\S]*?)<\/\1>/g
  const segments = []
  let lastIndex = 0
  let hasMarks = false
  let match

  while ((match = regex.exec(text)) !== null) {
    hasMarks = true
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) })
    }
    segments.push({ text: match[2], markIndex: parseInt(match[1], 10) - 1 })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) })
  }

  if (!hasMarks) return { segments: [{ text }], hasMarks: false }
  return { segments, hasMarks }
}
