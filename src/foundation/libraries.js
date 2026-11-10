/**
 * ⭐ A LIBRARY IS ANY LOCAL PACKAGE A FOUNDATION DEPENDS ON: one whose files are on this disk to
 * edit, in the workspace, in another folder or in another repository. Nothing else marks one, no
 * key in its `package.json` and no kind of its own, so a package made by hand, kept in a git
 * submodule or cloned is a library as soon as a foundation depends on it. A foundation's build bundles
 * its libraries, so a library's files are the foundation's sources too: whatever asks what a
 * foundation's build reads asks this.
 *
 * Found through the foundation's `package.json`, then each library's own:
 *   - a `file:` or `link:` path names the library's folder, whatever the package manager made of
 *     it (pnpm copies a `file:` package from outside the workspace into its store, and the folder
 *     named is the one a developer edits);
 *   - any other spec (`workspace:`, a version range) is where Node would find the package, up the
 *     `node_modules` folders. One installed there is a copy of a release, and only a package that
 *     links back out of `node_modules` is a library.
 * A foundation's `devDependencies` count, since a foundation is bundled and what it imports ships
 * whichever list names it; a library's don't, since they are its own tools. Neither do
 * `peerDependencies`, which the foundation provides. What a foundation's build leaves to the
 * runtime (`DEFAULT_EXTERNALS`) is never bundled, so it is never a library.
 *
 * @module @uniweb/build/foundation/libraries
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_EXTERNALS } from '../import-map-plugin.js'

const EXTERNAL = new Set(DEFAULT_EXTERNALS)

const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function readPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Where Node finds `name` from `fromDir`: the first `node_modules/<name>` up the folders, followed. */
function installedAt(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const at = join(dir, 'node_modules', name)
    if (existsSync(join(at, 'package.json'))) return real(at)
    if (dirname(dir) === dir) return null
  }
}

/** A dependency's folder when it is local, else null. */
function libraryDir(fromDir, name, spec) {
  const path = /^(?:file|link):(.+)$/.exec(spec)?.[1]
  if (path) {
    const dir = real(resolve(fromDir, path))
    return dir && existsSync(join(dir, 'package.json')) ? dir : null
  }
  const dir = installedAt(fromDir, name)
  // ⚖️ Judged from where the two meet, so a workspace that is itself under a `node_modules` folder
  // still has libraries.
  return dir && !relative(fromDir, dir).split(sep).includes('node_modules') ? dir : null
}

/**
 * The libraries a package bundles, its libraries' libraries included, each once.
 *
 * @param {string} packageDir - a foundation (or a library)
 * @returns {Array<{ name: string, dir: string }>} each by the name it is depended on by, and its
 *   real folder; in the order found
 */
export function librariesOf(packageDir) {
  const start = real(packageDir) ?? resolve(packageDir)
  const seen = new Set([start])
  const found = []
  const visit = (dir, fields) => {
    const pkg = readPackage(dir)
    for (const field of fields) {
      for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) {
        if (typeof spec !== 'string' || EXTERNAL.has(name)) continue
        const lib = libraryDir(dir, name, spec)
        if (!lib || seen.has(lib)) continue
        seen.add(lib)
        found.push({ name, dir: lib })
        visit(lib, ['dependencies', 'optionalDependencies'])
      }
    }
  }
  visit(start, ['dependencies', 'devDependencies', 'optionalDependencies'])
  return found
}
