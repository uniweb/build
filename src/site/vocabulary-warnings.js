/**
 * Say, with the file in hand, what in a document a page leaves out.
 *
 * A document holds the rich-text vocabulary (`@uniweb/content-reader/vocabulary`):
 * its types and attributes, and the values that reach a page's markup. What is
 * outside it — a link to `javascript:`, an inert `{.name}`, MathML outside the
 * allowlist — the renderer leaves out of the page, and a backend that cleans the
 * content it stores removes, so the next pull would write the file without it.
 * The author hears it here first, once per thing, naming the file.
 */
import { outsideVocabulary } from '@uniweb/content-reader/vocabulary'

const SAYS = {
  url: (f) => `a link to \`${f.found}\` is never followed`,
  target: (f) => `\`target=${f.found}\` is not a link target`,
  'style-name': (f) => `\`{${f.found}}\` is not a style name`,
  color: (f) => `\`${f.found}\` is not a colour`,
  mathml: (f) => `a formula's MathML holds what a page cannot show (${f.found})`,
  'ref-id': (f) => `\`${f.found}\` is not an inset reference`,
}

/**
 * Warn, for each thing in `doc` outside the vocabulary, with the file it came from.
 *
 * @param {Object} doc - a ProseMirror document
 * @param {(message: string) => void} warn - prints one message, prefixed with the file
 */
export function warnOutsideVocabulary(doc, warn) {
  for (const finding of outsideVocabulary(doc)) {
    const says = SAYS[finding.rule]?.(finding) ?? `\`${finding.found}\` is not part of a document (${finding.rule})`
    warn(`${says} — a page leaves it out, and a backend that cleans what it stores removes it`)
  }
}
