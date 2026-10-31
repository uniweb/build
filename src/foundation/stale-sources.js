/**
 * A `@source` that finds nothing — the CSS loses what was behind it, and nothing says so.
 *
 * `@source` tells Tailwind where else to look for class names, relative to the stylesheet. A path
 * that leads nowhere is no error to Tailwind: the build succeeds, and every class found only
 * there is missing from the CSS. Measured 2026-10-31 on four foundations moved up a level with
 * `@source "../node_modules/@uniweb/kit/src/**"` left as it was: exit 0, and CSS of 128,255 bytes
 * down to 78,634, with only the foundation's digest to show it. And on a template installed with
 * npm, which hoists kit to the workspace's root, away from the `./node_modules/@uniweb/kit` the
 * template names: 39,183 bytes where pnpm gave 51,967, from the first build.
 *
 * ⚖️ Only a path that reaches outside the foundation's own source counts: one that climbs, or one
 * into `node_modules`. A starter's `./components/**` names a folder a foundation may not have
 * yet, and with no such folder there is nothing to lose.
 *
 * @module @uniweb/build/foundation/stale-sources
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// `@source not "…"` excludes a path and `@source inline("…")` names no path: neither has a quote
// right after the keyword.
const SOURCE = /@source\s+(["'])(.+?)\1/g

/** The part of a glob with no pattern in it: the folder it starts from. */
function fixedPrefix(glob) {
  const at = glob.search(/[*?[{(!]/)
  return at < 0 ? glob : glob.slice(0, glob.lastIndexOf('/', at) + 1)
}

const reachesOut = (path) => path.startsWith('../') || /(^|\/)node_modules(\/|$)/.test(path)

// ⛔ Quoted strings are skipped, not searched: a glob's `/**/` reads exactly like a comment.
const withoutComments = (css) =>
  css.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\*[\s\S]*?\*\//g, (_, quoted) => quoted ?? '')

/**
 * The `@source` lines of a stylesheet that reach outside the foundation and find nothing.
 *
 * @param {string} stylesPath - the foundation's stylesheet; none there, none stale
 * @returns {Array<{ source: string, missing: string, foundAt: string|null }>} each path as written,
 *   the part of it that does not exist, and, for a package, where it is from the stylesheet
 */
export function staleSources(stylesPath) {
  let css
  try {
    css = readFileSync(stylesPath, 'utf8')
  } catch {
    return []
  }
  const dir = dirname(stylesPath)
  const stale = []
  for (const [, , source] of withoutComments(css).matchAll(SOURCE)) {
    const missing = fixedPrefix(source)
    if (missing && reachesOut(source) && !existsSync(resolve(dir, missing))) {
      stale.push({ source, missing, foundAt: foundAbove(dir, missing) })
    }
  }
  return stale
}

/**
 * Where a path into `node_modules` does lead, looking up from the stylesheet as a package is
 * resolved: relative to the stylesheet, or null when that package is nowhere above it.
 */
function foundAbove(dir, missing) {
  const tail = /(?:^|\/)(node_modules\/.*)$/.exec(missing)?.[1]
  if (!tail) return null
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, tail))) {
      const rel = relative(dir, join(at, tail))
      return rel.startsWith('.') ? rel : `./${rel}`
    }
    if (dirname(at) === at) return null
  }
}

/** A stale line's note: what is missing, and where it is instead when that is known. */
export const staleSourceNote = ({ missing, foundAt }) => `no ${missing}${foundAt ? `; it is at ${foundAt}` : ''}`

/** What the foundation build prints when `staleSources` finds any. */
export function staleSourcesWarning(stale) {
  return [
    '[uniweb] styles.css has a @source that finds nothing, so the CSS is missing every class that was only there:',
    ...stale.map((line) => `  @source "${line.source}"  (${staleSourceNote(line)})`),
    'Paths are relative to styles.css.'
  ].join('\n')
}
