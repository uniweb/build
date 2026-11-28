/**
 * What a section's `background.overlay` holds that the runtime will not draw.
 *
 * The runtime draws an overlay only with `enabled: true` and reads only its own keys
 * (`runtime/src/background.js`, `Overlay`), so anything else is dropped without a word: an overlay
 * written from memory as `{ type: gradient, gradient: 'linear-gradient(…)' }` built, and rendered
 * white text over a bright photo with no darkening. A build and `uniweb dev` say so here, with the
 * file in hand; the runtime stays as it is (§3.9: nothing editor-only reaches a published page).
 *
 * @module
 */

const OVERLAY_KEYS = new Set(['enabled', 'type', 'opacity', 'gradient'])
const OVERLAY_TYPES = new Set(['dark', 'light'])
const GRADIENT_KEYS = new Set(['angle', 'start', 'startPosition', 'end', 'endPosition'])

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const list = (keys) => keys.map((k) => `\`${k}\``).join(', ')

/**
 * @param {unknown} background - a section's `background` param, as written
 * @returns {string[]} one sentence per problem, empty when the overlay draws as written
 */
export function overlayProblems(background) {
  if (!isMap(background) || background.overlay === undefined) return []
  const overlay = background.overlay
  if (typeof overlay === 'number') return [] // the shorthand: `overlay: 0.5`
  if (!isMap(overlay)) {
    return [`background.overlay: ${JSON.stringify(overlay)} is not an overlay — write \`overlay: 0.5\` or \`overlay: { enabled: true, type: dark, opacity: 0.5 }\`. No overlay is drawn.`]
  }
  const out = []
  const unknown = Object.keys(overlay).filter((k) => !OVERLAY_KEYS.has(k))
  if (unknown.length) {
    out.push(`background.overlay: ${list(unknown)} ${unknown.length === 1 ? 'is' : 'are'} not read — an overlay takes ${list([...OVERLAY_KEYS])}.`)
  }
  if (overlay.type !== undefined && !OVERLAY_TYPES.has(overlay.type)) {
    out.push(`background.overlay.type: ${JSON.stringify(overlay.type)} is not \`dark\` or \`light\` — it is drawn dark. A fading overlay is \`gradient: { angle, start, startPosition, end, endPosition }\`.`)
  }
  if (overlay.gradient !== undefined) {
    if (!isMap(overlay.gradient)) {
      out.push(`background.overlay.gradient is ${JSON.stringify(overlay.gradient)}, not its fields — write \`gradient: { angle, start, startPosition, end, endPosition }\`, each optional.`)
    } else {
      const extra = Object.keys(overlay.gradient).filter((k) => !GRADIENT_KEYS.has(k))
      if (extra.length) out.push(`background.overlay.gradient: ${list(extra)} ${extra.length === 1 ? 'is' : 'are'} not read — it takes ${list([...GRADIENT_KEYS])}.`)
    }
  }
  if (overlay.enabled !== true) {
    out.push('background.overlay is drawn only with `enabled: true`, so nothing is drawn.')
  }
  return out
}
