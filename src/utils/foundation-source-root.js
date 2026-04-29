/**
 * Resolve a foundation package's source root by reading its `package.json::main`.
 *
 * Two layouts are supported:
 *
 *   - Nested (legacy): `main: "./src/_entry.generated.js"` → source root is `<foundationDir>/src/`
 *   - Flat: `main: "./_entry.generated.js"` → source root is `<foundationDir>/`
 *
 * The build derives every other path (sections, components, layouts, foundation.js,
 * styles.css, the generated entry) from this single value. There is no filesystem
 * probing — `main` is the source of truth for where the package's code lives,
 * which is also exactly what npm-style consumers use.
 *
 * Existing foundations in the wild keep `main: "./src/_entry.generated.js"` and
 * resolve to the same nested layout they always had. New scaffolds (per the
 * first-run-ux plan, Thread D) ship with the flat layout and `main: "./_entry.generated.js"`.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Resolve a foundation's source directory (relative to the foundation root).
 *
 * @param {string} foundationDir - Absolute path to the foundation package root.
 * @returns {string} Source directory, relative to `foundationDir` (e.g. `'src'` or `'.'`).
 */
export function resolveFoundationSrcDir(foundationDir) {
  const pkgPath = join(foundationDir, 'package.json')
  if (!existsSync(pkgPath)) {
    // No package.json — fall back to legacy nested layout. Don't throw; the
    // caller (e.g. the docs builder) may be inspecting a partial directory
    // and existsSync checks downstream will surface the real error.
    return 'src'
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return 'src'
  }

  const main = pkg.main
  if (typeof main !== 'string' || !main) {
    return 'src'
  }

  // dirname('./src/_entry.generated.js') → './src'    → 'src'
  // dirname('./_entry.generated.js')      → '.'        → '.'
  // dirname('src/_entry.generated.js')    → 'src'      → 'src'
  const dir = dirname(main).replace(/^\.\//, '')
  return dir || '.'
}

/**
 * Resolve a foundation's absolute source directory.
 *
 * @param {string} foundationDir - Absolute path to the foundation package root.
 * @returns {string} Absolute path to the source directory.
 */
export function resolveFoundationSrcPath(foundationDir) {
  const srcDir = resolveFoundationSrcDir(foundationDir)
  return srcDir === '.' ? foundationDir : resolve(foundationDir, srcDir)
}
