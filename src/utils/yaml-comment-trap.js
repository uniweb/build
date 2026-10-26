/**
 * Values YAML cut short at a `#` the author meant as part of them.
 *
 * YAML reads a `#` with a space before it as the start of a comment, so in a plain (unquoted)
 * value it ends the value there: `gradient: linear-gradient(165deg, #0c1226 0%, #05060f 100%)`
 * is `linear-gradient(165deg,` — an invalid value, which the browser drops — and
 * `primary: #3b82f6` is no value at all. YAML is right; nothing in the file is malformed, so
 * nothing fails, and the color or the gradient is just not there.
 *
 * Said only where the file shows it, so a comment meant as one is never questioned:
 *   - **cut** — a value left with a `(` it never closes, followed in the file by ` #`;
 *   - **empty** — a key left with no value, followed in the file by a color: `#` and 3 to 8
 *     hex digits.
 *
 * ⭐ Quoting the value is the fix, and the one the message gives:
 * `gradient: "linear-gradient(165deg, #0c1226 0%, #05060f 100%)"`. Measured 2026-10-26: a book
 * page's gradient had not shown since the page was written, in either renderer, and nothing
 * said so.
 *
 * @module @uniweb/build/utils/yaml-comment-trap
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** More `(` than `)`: a function the value opens and never closes. */
function unclosed(value) {
  let depth = 0
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')' && depth > 0) depth--
  }
  return depth > 0
}

/**
 * @param {string} text - the YAML as written
 * @param {*} parsed - what it parsed to
 * @returns {{ path: string, kind: 'cut'|'empty', message: string }[]}
 */
export function valuesCutByComment(text, parsed) {
  if (!text || !text.includes('#') || !parsed || typeof parsed !== 'object') return []
  const found = []
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, null))
      return
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, k)
      return
    }
    if (typeof value === 'string' && unclosed(value)) {
      const m = text.match(new RegExp(`${escapeRe(value)}[ \\t]+(#.*?)[ \\t]*$`, 'm'))
      if (!m) return
      const meant = `${value} ${m[1]}`
      found.push({
        path,
        kind: 'cut',
        message:
          `\`${path}\` is cut short at \`${value}\` — YAML reads a \`#\` after a space as a comment. ` +
          `Quote the value: ${key ?? path}: "${meant.replace(/"/g, '\\"')}"`
      })
      return
    }
    if (value === null && key) {
      const m = text.match(new RegExp(`^[ \\t]*(?:-[ \\t]+)?${escapeRe(key)}[ \\t]*:[ \\t]+(#[0-9A-Fa-f]{3,8})\\b`, 'm'))
      if (!m) return
      found.push({
        path,
        kind: 'empty',
        message: `\`${path}\` is empty — YAML reads \`${m[1]}\` as a comment. Quote the value: ${key}: "${m[1]}"`
      })
    }
  }
  walk(parsed, '', null)
  return found
}
