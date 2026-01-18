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
