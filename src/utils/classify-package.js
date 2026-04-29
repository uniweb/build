/**
 * Classify a Uniweb package as `'foundation'`, `'site'`, or `null`.
 *
 * One sync classifier shared by the build, the CLI, and any tooling that
 * needs to ask "what kind of Uniweb package is this directory?". Replaces
 * four duplicated implementations across the CLI that used different
 * signals and could disagree at the edges.
 *
 * Signals are checked strict-first, lenient-fallback:
 *
 *   1. `package.json::main` matches `_entry.generated.js`  → foundation
 *      (mandatory by build contract; uniquely identifies a Uniweb foundation;
 *      set at scaffold time, before any install or build)
 *   2. `site.yml` or `document.yml` at the package root    → site
 *   3. Authored declarations file (`main.js`, fallback `foundation.js`) at
 *      the resolved source root                            → foundation
 *      (covers unscaffolded directories without `package.json` yet)
 *   4. `pages/` at the package root                        → site
 *   5. otherwise                                           → null
 *
 * Sync because the I/O is microsecond-scale and consumers were already
 * blocking on the async version. Sync also lets workspace-scan helpers
 * (findFoundations, findSites) be plain `.filter()` calls.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveFoundationSrcPath } from './foundation-source-root.js'

/**
 * @param {string} packagePath - Absolute path to the package directory.
 * @returns {'foundation'|'site'|null}
 */
export function classifyPackage(packagePath) {
  // 1. Strongest foundation marker: package.json::main points at the
  //    build-generated entry. Only Uniweb foundations have this shape.
  const pkgPath = join(packagePath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (typeof pkg.main === 'string' && /_entry\.generated\.js$/.test(pkg.main)) {
        return 'foundation'
      }
    } catch {
      // Malformed package.json — fall through to file-based signals.
    }
  }

  // 2. Strongest site marker: configuration file at root.
  if (existsSync(join(packagePath, 'site.yml')) ||
      existsSync(join(packagePath, 'document.yml'))) {
    return 'site'
  }

  // 3. Foundation fallback for unscaffolded directories: authored
  //    declarations file at the resolved source root. Accept both the
  //    new name (main.js) and the legacy name (foundation.js).
  const srcDir = resolveFoundationSrcPath(packagePath)
  if (existsSync(join(srcDir, 'main.js'))) return 'foundation'
  if (existsSync(join(srcDir, 'foundation.js'))) return 'foundation'

  // 4. Site fallback: pages/ at root.
  if (existsSync(join(packagePath, 'pages'))) return 'site'

  return null
}

/**
 * Check whether a foundation package declares `extension: true` in its
 * authored declarations file. Uses a regex on the source rather than
 * importing the module — keeps the classifier sync and side-effect-free,
 * and works before any install.
 *
 * @param {string} packagePath - Absolute path to the package directory.
 * @returns {boolean}
 */
export function isExtensionPackage(packagePath) {
  const srcDir = resolveFoundationSrcPath(packagePath)
  // Prefer the schema's recorded role if the build has run.
  const schemaPath = join(packagePath, 'dist', 'meta', 'schema.json')
  if (existsSync(schemaPath)) {
    try {
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
      if (schema?._self?.role === 'extension') return true
    } catch {
      // Fall through to source-based check.
    }
  }
  // Source-based fallback. Accept both filenames.
  for (const name of ['main.js', 'foundation.js']) {
    const filePath = join(srcDir, name)
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf8')
        return /extension\s*:\s*true/.test(content)
      } catch {
        return false
      }
    }
  }
  return false
}
