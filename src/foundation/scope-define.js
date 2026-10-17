/**
 * `__FOUNDATION_SCOPE__` — the scope a foundation's own `@/x` names, stamped
 * into its bundle.
 *
 * A foundation names its own types `@/x` wherever it names one, and a call to
 * the site's backend is one of those places (`useRecords({ schema: '@/track' })`,
 * `@uniweb/api`). A backend holds the type under the name `register` stored it
 * under, `@<scope>/x`, so the call must say the scope — the one in the
 * foundation's name (`foundation-name.js`), which only its build knows. The
 * bundle reads it from this constant and names the type with `qualifyRef`
 * (`@uniweb/schemas/refs`), the rule `register` and a push use.
 *
 * Three values, and each says something:
 *
 *   '@acme'    a build of `@acme/marketing` that ships — `uniweb build`, and
 *              `register`, which builds through it: `@/x` is sent as `@acme/x`.
 *   null       the foundation as a working copy — served by `uniweb dev`, or
 *              rebuilt by it on each save — or a name with no scope yet: `@/x`
 *              is sent as written, which is how a local mock holds the
 *              foundation's own types.
 *   undefined  not a Uniweb build: `@uniweb/api` refuses `@/x` rather than guess.
 *
 * ⭐ Real-backend testing is a job for a built foundation [Diego, 2026-10-17].
 * A dev rebuild never ships: it empties `dist/` and writes no `entry-ssr.js`,
 * so `register` builds again before it uploads (`foundationNeedsBuild`).
 *
 * An author's own `define` for the key wins: it is left untouched.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFoundationConfig } from '../schema.js'
import { foundationNameOf, splitFoundationName } from '../foundation-name.js'
import { resolveFoundationSrcDir } from '../utils/foundation-source-root.js'
import { hasDevRebuildMarker } from './dev-rebuild.js'

export const FOUNDATION_SCOPE_KEY = '__FOUNDATION_SCOPE__'

/**
 * The define, for a build of the foundation at `foundationDir` — its own, its
 * SSR twin's, or a site's that bundles it.
 *
 * @param {{ foundationDir?: string }} [options] - default: the Vite root
 * @returns {import('vite').Plugin}
 */
export function foundationScopeDefine({ foundationDir } = {}) {
  return {
    name: 'uniweb:foundation-scope',
    async config(config, { command }) {
      if (config.define && FOUNDATION_SCOPE_KEY in config.define) return
      const workingCopy = command === 'serve' || hasDevRebuildMarker(config)
      const scope = workingCopy ? null : await foundationScope(foundationDir ?? config.root ?? process.cwd())
      return { define: { [FOUNDATION_SCOPE_KEY]: JSON.stringify(scope) } }
    },
  }
}

/**
 * The scope in a foundation's name — `@acme` for `@acme/marketing`, null for a
 * bare name — read as the build reads the name (`buildSchema`): `main.js`'s
 * `name`, else `package.json`'s (`foundationNameOf`). A `main.js` that does not
 * load stops the build here, as it stops the schema.
 *
 * ⛔ Not `readFoundationName`, which refuses a leftover `uniweb.scope` or
 * `uniweb.id` for `register`: a build does not register, and warns about them
 * instead (`loadPackageJson`) — the scope in the name is what registers.
 *
 * @param {string} foundationDir
 * @returns {Promise<string|null>}
 */
export async function foundationScope(foundationDir) {
  const srcDir = join(foundationDir, resolveFoundationSrcDir(foundationDir))
  const config = await loadFoundationConfig(srcDir)
  const { name } = foundationNameOf({ config, pkg: readPackage(foundationDir) })
  return splitFoundationName(name).scope
}

function readPackage(foundationDir) {
  try {
    return JSON.parse(readFileSync(join(foundationDir, 'package.json'), 'utf8')) || {}
  } catch {
    return {}
  }
}
