/**
 * Infer display title from PascalCase component name.
 *
 * TeamRoster → "Team Roster"
 * CTA → "CTA"
 * FAQSection → "FAQ Section"
 * Hero → "Hero"
 *
 * @param {string} name - PascalCase component name
 * @returns {string} Human-readable title
 */
export function inferTitle(name) {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
}
