/**
 * The standard data schema a records folder's or a query's name points to, if any: `testimonials`
 * and `testimonial` → `testimonial` (`@std/testimonial`). Named in a refusal of records with no
 * data schema, so the agent that meets it reaches for the type the app already edits with a form
 * made for it rather than writing a new one [Diego, 2026-11-11: "we should question what we
 * explain … so as to not reinvent the wheel"]. A suggestion only: nothing is typed by it — a guess
 * applied silently is what the retired schema-guessing of record translation was.
 */
import { isStandardSchema } from '@uniweb/schemas'

/**
 * @param {string|null|undefined} name - a folder's or a query's name (`testimonials`)
 * @returns {string|null} the standard schema's name (`testimonial`), or null
 */
export function standardTypeFor(name) {
  if (typeof name !== 'string' || !name) return null
  const candidates = [name]
  if (name.endsWith('ies')) candidates.push(name.slice(0, -3) + 'y')
  if (name.endsWith('es')) candidates.push(name.slice(0, -2))
  if (name.endsWith('s')) candidates.push(name.slice(0, -1))
  return candidates.find((n) => isStandardSchema(n)) || null
}
