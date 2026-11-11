/**
 * Say, with the file in hand, each param a section's frontmatter names like a field of its content —
 * `title:`, `items:` — when its section type declares no param of that name.
 *
 * ⭐ A section's frontmatter reaches its component as `params`, and its body as `content`, and
 * neither is copied into the other (`@uniweb/runtime`, `BlockRenderer.jsx`). So a `title:` in the
 * frontmatter never titles the section: the title is the body's heading. ⛔ Until 2026-11-11 the
 * runtime spread every param over `content` too, so a `title:` there replaced the heading, and a
 * site written for that loses its title without a word — this is the word.
 *
 * A param its type declares is one its component reads, and is not said: the name is the
 * developer's to choose. A type this foundation doesn't have, or a foundation not at hand, says
 * nothing either. A note, never a failure, since the page renders. Said once per file and key in a
 * process: `uniweb dev` collects the site again on every edit, and a push builds its document more
 * than once.
 */

/**
 * The fields of a section's content its body gives: what the content parser returns
 * (`@uniweb/semantic-parser`), less `raw`, which no author writes, and `data`, which a frontmatter
 * refuses (`SECTION_KEYS`, `@uniweb/schemas/section`). `math` and `tables` arrive only when the body
 * has one. `tests/params-named-for-content.test.js` holds it to the parser.
 */
export const BODY_FIELDS = Object.freeze([
  'title', 'pretitle', 'subtitle', 'paragraphs', 'links', 'images', 'icons', 'videos', 'documents',
  'insets', 'media', 'lists', 'quotes', 'snippets', 'headings', 'items', 'sequence', 'math', 'tables',
])

const FIELDS = new Set(BODY_FIELDS)

/** How the body gives each field of the headline, for the note to say. */
const HEADLINE = {
  title: (v) => `its heading: write \`# ${v}\` at the top of the body`,
  subtitle: (v) => `a heading straight after the title, one level smaller: \`## ${v}\``,
  pretitle: (v) => `the label line above the title: \`#> ${v}\``,
}

const said = new Set()

/**
 * The params a section's frontmatter names like a field of its content that its section type
 * declares no param of, or `[]` when the type, or the foundation, is not at hand.
 *
 * @param {object} params - the section's params, as stored
 * @param {string|null} type - the section's `type:`; with none, the foundation's `defaultSection`
 * @param {Object|null} sectionTypes - the foundation's schema, each section type's entry by name
 * @returns {{ key: string, type: string }[]}
 */
export function paramsNamedForContent(params, type, sectionTypes) {
  if (!params || typeof params !== 'object') return []
  const name = type || sectionTypes?._self?.defaultSection || null
  const entry = name && !name.startsWith('_') ? sectionTypes?.[name] : null
  if (!entry || typeof entry !== 'object') return []
  const declared = entry.params && typeof entry.params === 'object' ? entry.params : {}
  return Object.keys(params)
    .filter((key) => FIELDS.has(key) && !Object.prototype.hasOwnProperty.call(declared, key))
    .map((key) => ({ key, type: name }))
}

/**
 * Say each of `paramsNamedForContent`, once per file and key in this process.
 *
 * @param {object} params - the section's params, as stored
 * @param {string|null} type - the section's `type:`
 * @param {Object|null} sectionTypes - the foundation's schema, each section type's entry by name
 * @param {{ file: string, warn: (message: string) => void }} where - the section's file, and how to
 *   print one message, prefixed with it
 */
export function noteParamsNamedForContent(params, type, sectionTypes, { file, warn }) {
  for (const { key, type: name } of paramsNamedForContent(params, type, sectionTypes)) {
    const once = `${file}\u0000${key}`
    if (said.has(once)) continue
    said.add(once)
    const value = params[key]
    const shown = typeof value === 'string' && value.trim() && !value.includes('\n') ? value.trim() : '…'
    const how = HEADLINE[key]
    warn(
      `\`${key}:\` is a param, and ${name} declares no \`${key}\` param, so it doesn't set the section's ` +
        (how ? `${key} (\`content.${key}\`), which is ${how(shown)}.` : `\`content.${key}\`, which comes from the body.`)
    )
  }
}
