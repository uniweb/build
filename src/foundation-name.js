// A foundation's NAME — what it registers as (`@<org>/<name>`) and what a site pins
// (`@<org>/<name>@<version>`). A registry keys foundations by it: (name, version) is
// unique on a backend, and the uuid a backend mints for one never leaves that backend,
// so the name is the identity that travels.
//
// ⭐ ONE RULE, and every reader asks it: the build (`schema.json`'s `_self.name`),
// `uniweb register`, and `push` / `publish` looking a local foundation up in a
// catalog. **`main.js`'s `name`, else `package.json`'s `name`.**
//
// ⛔ `package.json::name` IS WORKSPACE PLUMBING FIRST. pnpm needs it unique in the
// workspace, and a site depends on it by that name (`"src": "file:../src"`,
// `site.yml::foundation: src`). The scaffold names it `src` for exactly that reason,
// which is why it is only the fallback here — and why `src` and `foundation` are
// refused as a foundation's name: they name the folder, not the foundation, and every
// project in an org would register the same one.
//
// ⛔ `package.json::uniweb.id` WAS A REGISTRY-NAME OVERRIDE, 2026-07-17 → 2026-09-21.
// It is retired: the name lives in `main.js`, and two homes for one fact is how `push`
// and `register` came to look the same foundation up under different names.

/** Names that say where the code lives, not what the foundation is. */
export const FORBIDDEN_FOUNDATION_NAMES = new Set(['src', 'foundation'])

// One segment of a name: lowercase letters, digits and inner hyphens.
const SEGMENT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * The foundation's name, by the one rule: `main.js`'s `name`, else `package.json`'s.
 *
 * @param {{ config?: object, pkg?: object }} sources - `main.js`'s default export
 *   and the parsed `package.json`
 * @returns {{ name: string|null, source: 'main.js'|'package.json'|null }}
 */
export function foundationNameOf({ config, pkg } = {}) {
  const fromConfig = typeof config?.name === 'string' ? config.name.trim() : ''
  if (fromConfig) return { name: fromConfig, source: 'main.js' }
  const fromPkg = typeof pkg?.name === 'string' ? pkg.name.trim() : ''
  if (fromPkg) return { name: fromPkg, source: 'package.json' }
  return { name: null, source: null }
}

/**
 * Is this a name a foundation can register under? `marketing`, or `@acme/marketing`
 * when the name carries its own scope.
 *
 * @param {unknown} name
 * @returns {string|null} why it cannot, or null when it can
 */
export function checkFoundationName(name) {
  if (typeof name !== 'string' || !name.trim()) return 'the foundation has no name'
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name)
  if (!scoped && name.includes('/')) {
    return `"${name}" is not a foundation name — it is a name, or @org/name`
  }
  const [scope, bare] = scoped ? [scoped[1], scoped[2]] : [null, name]
  if (FORBIDDEN_FOUNDATION_NAMES.has(bare)) {
    return `"${bare}" names the folder, not the foundation — and every project in an org would register the same one`
  }
  if (!SEGMENT.test(bare) || (scope !== null && !SEGMENT.test(scope))) {
    return `"${name}" is not a foundation name — use lowercase letters, digits and hyphens (like "marketing")`
  }
  return null
}
