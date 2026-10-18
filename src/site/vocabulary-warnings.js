/**
 * Say, with the file in hand, what in a document a page leaves out.
 *
 * A document holds the rich-text vocabulary (`@uniweb/content-reader/vocabulary`):
 * its types and attributes, and the values that reach a page's markup. What is
 * outside it — a link to `javascript:`, an inert `{.name}`, MathML outside the
 * allowlist — the renderer leaves out of the page, and a backend that cleans the
 * content it stores removes, so the next pull would write the file without it.
 * The author hears it here first, once per thing, naming the file — and a push
 * says it again for what the backend removed, in the same words (`uwx/cleaned.js`).
 */
import { outsideVocabulary } from '@uniweb/content-reader/vocabulary'

/**
 * A value as a message shows it: on one line, each control character escaped, and a long
 * one cut short — an image held as data can run to megabytes.
 *
 * @param {*} value
 * @returns {string}
 */
export function shown(value) {
  const line = String(value).replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

const SAYS = {
  url: (f) => `a link to \`${shown(f.found)}\` is never followed`,
  target: (f) => `\`target=${shown(f.found)}\` is not a link target`,
  'style-name': (f) => `\`{${shown(f.found)}}\` is not a style name`,
  color: (f) => `\`${shown(f.found)}\` is not a colour`,
  mathml: (f) => `a formula's MathML holds what a page cannot show (${shown(f.found)})`,
  'ref-id': (f) => `\`${shown(f.found)}\` is not an inset reference`,
}

/**
 * One finding of `outsideVocabulary`, as a sentence: what it is, and why a page leaves it out.
 *
 * @param {{rule: string, found: string}} finding
 * @returns {string}
 */
export function saysOutside(finding) {
  return SAYS[finding.rule]?.(finding) ?? `\`${shown(finding.found)}\` is not part of a document (${finding.rule})`
}

/**
 * Warn, for each thing in `doc` outside the vocabulary, with the file it came from.
 *
 * @param {Object} doc - a ProseMirror document
 * @param {(message: string) => void} warn - prints one message, prefixed with the file
 */
export function warnOutsideVocabulary(doc, warn) {
  for (const finding of outsideVocabulary(doc)) {
    warn(`${saysOutside(finding)} — a page leaves it out, and a backend that cleans what it stores removes it`)
  }
}
