/**
 * What counts as a small edit: the app's rule for when a translation stays with its row, flagged, after
 * the row's source changes. Each side holds its own copy, so a pull and a push flag the rows the editor
 * flags. The editor's was measured from the outside on 2026-10-31, with pairs pushed to it
 * (`tests/i18n-edit-keeps-translation.test.js`), since it re-tests a row it reads: a row kept under a text
 * it does not count as similar shows the old translation, and no flag.
 */

const wordsOf = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []

/**
 * How much of two texts is the same: twice the words they share, each as often as both have it, over the
 * words of both. Case and punctuation are no words, and a hyphen or an apostrophe splits one.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} from 0 to 1
 */
export function wordOverlap(a, b) {
  const [first, second] = [wordsOf(a), wordsOf(b)]
  if (first.length + second.length === 0) return 0
  const left = new Map()
  for (const word of first) left.set(word, (left.get(word) || 0) + 1)
  let shared = 0
  for (const word of second) {
    if (!left.get(word)) continue
    left.set(word, left.get(word) - 1)
    shared++
  }
  return (2 * shared) / (first.length + second.length)
}

/** Whether a translation made from one text stays with another. */
export const isSmallEdit = (a, b) => wordOverlap(a, b) >= 0.5
