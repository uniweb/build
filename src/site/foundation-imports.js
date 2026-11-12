/**
 * ⭐ A SITE READS ITS FOUNDATION FROM THE FOLDER ITS RESOLVER FOUND, WHATEVER A PACKAGE MANAGER
 * INSTALLED. `#foundation` and `#foundation/<sub>` (what a site's `entry.js` imports) resolve
 * through the foundation's own `exports` map, read in the directory `detectFoundationType`
 * returned: `.` to its entry, `./styles` to its stylesheet. The package manager's copy of the
 * foundation in `node_modules` is never read.
 *
 * Until 2026-11-12 the site handed Vite the foundation's NAME, so Vite found it a second time,
 * through `node_modules`. Under pnpm a site's `file:` dependency on its foundation is a link only
 * while site and foundation resolve the same versions of what they share; after any install that
 * resolves them apart it is a copy, a snapshot of the foundation at that install. A checkout
 * then built the snapshot, edits to the foundation did not reach the site, and the build said so
 * only in a warning and reported success (measured on a project's six sites, 2026-11-11). A fresh
 * clone stopped instead, at an entry the snapshot did not hold.
 *
 * Aliasing `#foundation` to the folder was measured once and failed (2026-09-01): an alias
 * replaces a prefix, so `#foundation/styles` became `<folder>/styles` and skipped the exports
 * map, where `./styles` names `./styles.css`. Resolving through the map keeps it.
 *
 * Like `library-imports.js`, which reads a library the foundation bundles from its folder too.
 *
 * @module @uniweb/build/site/foundation-imports
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SPECIFIER = '#foundation'

// The conditions an export target may be keyed by, in the order a site's build reads them.
const CONDITIONS = { client: ['browser', 'import', 'module', 'default'], ssr: ['node', 'import', 'module', 'default'] }

/**
 * The file an `exports` map names for a subpath, relative to the package, or null when it
 * names none. Handles a string map, a subpath map, condition objects, arrays of targets and
 * one `*` per pattern, which is what Node reads.
 *
 * @param {object} pkg - the foundation's package.json
 * @param {string} subpath - '.' or './<sub>'
 * @param {string[]} [conditions]
 * @returns {string|null}
 */
export function foundationExportTarget(pkg, subpath, conditions = CONDITIONS.client) {
  const { exports } = pkg
  if (exports == null) {
    if (subpath === '.') return pkg.main || './index.js'
    return subpath
  }
  const map = typeof exports === 'string' || Array.isArray(exports) || !Object.keys(exports).some((k) => k.startsWith('.'))
    ? { '.': exports }
    : exports
  if (Object.prototype.hasOwnProperty.call(map, subpath)) return pick(map[subpath], conditions)
  for (const [key, target] of Object.entries(map)) {
    const star = key.indexOf('*')
    if (star < 0) continue
    const before = key.slice(0, star)
    const after = key.slice(star + 1)
    if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= key.length - 1) {
      const match = subpath.slice(before.length, subpath.length - after.length)
      const picked = pick(target, conditions)
      return picked == null ? null : picked.split('*').join(match)
    }
  }
  return null
}

function pick(target, conditions) {
  if (target == null) return null
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const t of target) {
      const picked = pick(t, conditions)
      if (picked != null) return picked
    }
    return null
  }
  for (const condition of conditions) {
    if (Object.prototype.hasOwnProperty.call(target, condition)) {
      const picked = pick(target[condition], conditions)
      if (picked != null) return picked
    }
  }
  return null
}

/**
 * The file `#foundation` or `#foundation/<sub>` names in a foundation's folder.
 *
 * @param {string} id - the specifier a site imports
 * @param {string} dir - the foundation's folder, as `detectFoundationType` found it
 * @param {{ ssr?: boolean }} [options]
 * @returns {string|null} an absolute path, or null when `id` is not the foundation's
 * @throws {Error} when the foundation's package.json names nothing for that subpath
 */
export function resolveFoundationImport(id, dir, { ssr = false } = {}) {
  if (id !== SPECIFIER && !id.startsWith(SPECIFIER + '/')) return null
  const subpath = '.' + id.slice(SPECIFIER.length)
  const pkgPath = join(dir, 'package.json')
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {}
  const target = foundationExportTarget(pkg, subpath, ssr ? CONDITIONS.ssr : CONDITIONS.client)
  if (target == null) {
    throw new Error(
      `[site] The foundation at ${dir} has no "${subpath}" in its package.json exports, so "${id}" names nothing. ` +
        `A foundation made by \`uniweb create\` exports ".", "./styles", "./dist" and "./dist/styles".`,
    )
  }
  return join(dir, target)
}

/**
 * The Vite plugin a site's build and dev server read `#foundation` through, ahead of every
 * other resolver.
 *
 * @param {string} dir - the foundation's folder, as `detectFoundationType` found it
 */
export function foundationImportsPlugin(dir) {
  return {
    name: 'uniweb:foundation-imports',
    enforce: 'pre',
    resolveId(id, _importer, options) {
      try {
        return resolveFoundationImport(id, dir, { ssr: !!options?.ssr })
      } catch (err) {
        this.error(err.message)
      }
    },
  }
}
