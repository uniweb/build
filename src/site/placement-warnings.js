/**
 * Say, with the file in hand, where a section's content asks for a placement its
 * section type does not honour.
 *
 * A section type declares the placements its flow honours — `sequence: {
 * placement }` in its `meta.js`, lowered by `@uniweb/schemas/content` — and an
 * editor offers an author only those. A file can still ask for any: the block
 * then sits in the text column, as it would with none. ⭐ A warning, never a
 * failure, since the page renders. ⛔ Section content only: a record's body is
 * shown by whatever section a site gives it, so no foundation schema says what
 * it may use [Diego, 2026-10-14].
 */
import { placementsNotOffered } from '@uniweb/schemas/content'

const BLOCK = { image: 'an image', video: 'a video', table: 'a table', icon: 'an icon', document: 'a document' }

/**
 * Warn, for each block in `doc` that asks for a placement its section type does
 * not offer, with the file it came from.
 *
 * @param {Object} doc - the section's content, a ProseMirror document
 * @param {string|null} type - the section's `type:`; with none, the foundation's
 *   `defaultSection`
 * @param {Object|null} sectionTypes - the foundation's schema: each section
 *   type's entry by name (`foundationSections`); null when it is not at hand
 * @param {(message: string) => void} warn - prints one message, prefixed with the file
 */
export function warnPlacementsNotOffered(doc, type, sectionTypes, warn) {
  const name = type || sectionTypes?._self?.defaultSection || null
  const entry = name && !name.startsWith('_') ? sectionTypes?.[name] : null
  if (!entry || typeof entry !== 'object') return

  for (const finding of placementsNotOffered(doc, entry)) {
    const block = BLOCK[finding.kind] || 'a block'
    const asked = `\`placement=${finding.placement}\``
    if (finding.kind === 'icon' || finding.kind === 'document') {
      warn(`${block} takes no placement, so ${asked} does nothing`)
      continue
    }
    const offers = finding.offered.length > 0 ? ` (it offers ${finding.offered.join(', ')})` : ''
    warn(`${block} asks for ${asked}, which ${name} does not offer${offers} — it sits in the text column`)
  }
}
