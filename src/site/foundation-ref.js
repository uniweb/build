/**
 * Where a site's foundation lives — the ONE resolver for a `site.yml::foundation`
 * declaration.
 *
 * ## Why this is a leaf and not part of the Vite config
 *
 * It began in `./config.js`, which imports a Vite plugin. That made it unreachable
 * from any lane that must not pull Vite — and the sync lane, needing exactly this
 * answer, grew its own weaker copy instead (`../uwx/collections.js`), which read
 * `package.json` `dependencies.foundation`: a key no current template produces, so
 * it returned null for every scaffolded site. A third copy in the CLI describes
 * itself as mirroring "a subset of" this one.
 *
 * Three implementations of one question, none of which agreed, and the cause was
 * a pure function sitting behind a bundler import. So it moved here, with no
 * dependency beyond `node:fs` and `node:path`, the same reason `@uniweb/core`'s
 * `route-match` and `data-paths` are leaves.
 *
 * ## What it answers, and what it refuses
 *
 * A site names its foundation; it does not name a path. This turns that name into
 * a location, or says it is a URL, or refuses — loudly — when the declaration is a
 * shape we do not support.
 *
 * ⛔ **A site's `package.json` is CLI scaffolding, not part of the site.** The
 * `file:` dep is consulted, but keyed by the DECLARED name from `site.yml` — the
 * declaration leads, and the manifest is one of the places an answer may be found.
 * Reversing that (starting from the manifest) is what the weaker copies did.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * Detect foundation type from the foundation config value
 *
 * Foundations are runtime federated modules, never npm packages — there is
 * no fall-through to `node_modules`. A foundation reference resolves to one
 * of two types:
 *
 *   - `'local'` — workspace-local source (sibling directory, file: dep, or
 *     `../../foundations/<name>/`). The build inlines or runtime-links it
 *     depending on the operating mode.
 *   - `'url'`  — loaded by URL at runtime. Two URL shapes:
 *       - `@org/name@ver`   → catalog ref (resolves against the registry CDN)
 *       - `https://...`    → arbitrary URL
 *
 * Versionless registry refs (`@org/name`) are rejected with a specific error —
 * they were a silent fall-through before. Versionless names that don't match
 * any local resolution path are also rejected, with guidance toward the right
 * shape.
 *
 * @param {string|Object} foundation - Foundation config from site.yml
 * @param {string} siteRoot - Path to site directory
 * @returns {{ type: 'local'|'url', name?: string, url?: string, cssUrl?: string, path?: string }}
 * @throws {Error} when the declaration shape is invalid (versionless registry
 *   ref, unknown name with no local match, etc.)
 */
export function detectFoundationType(foundation, siteRoot) {
  // Object form with explicit URL
  if (foundation && typeof foundation === 'object') {
    if (foundation.url) {
      return {
        type: 'url',
        url: foundation.url,
        cssUrl: foundation.css || foundation.cssUrl || null
      }
    }
    // Object form with name
    foundation = foundation.name || 'foundation'
  }

  // String form
  const name = foundation || 'foundation'

  // Check if it's a URL
  if (name.startsWith('http://') || name.startsWith('https://')) {
    // Try to infer CSS URL from JS URL
    const cssUrl = name.replace(/\.js$/, '.css').replace(/foundation\.js/, 'assets/style.css')
    return {
      type: 'url',
      url: name,
      cssUrl
    }
  }

  // Catalog registry ref: `@org/name@version`.
  //
  // A build does NOT turn this into a URL. Where a foundation is served is the
  // host's to say — a serve location is READ (from backend discovery, or from an
  // upload plan's `serve_base`), never reconstructed. `@uniweb/cli`'s
  // DISCOVERY_DEFAULTS carries no serve-root default for exactly this reason.
  // A build is offline and backend-optional by design, so it has nothing to ask.
  //
  // A ref names a foundation in the Uniweb platform's catalog, and `uniweb
  // publish` — the verb reserved for that target — has the platform resolve it,
  // running no vite build. That is one hosting target among many. The others
  // reach a host through `uniweb deploy --host=<adapter>` or `uniweb export`,
  // and both need a concrete URL, which the site declares: the runtime accepts
  // any URL, from any host.
  //
  // Until 2026-08-04 this returned `{base}/foundations/{ns}/{name}/{ver}/foundation.js`
  // against a hardcoded host, overridable only through an env var that did not
  // match the documented backend selection — so `--backend`, `uniweb login
  // --backend` and the documented env var all left it pinned — and the artifact
  // names were the pre-`entry.js` ones the build stopped emitting.
  const orgScopedMatch = /^@([a-z0-9_-]+)\/([a-z0-9_-]+)@(.+)$/.exec(name)
  if (orgScopedMatch) {
    throw new Error(
      [
        `Foundation "${name}" is a catalog ref, and a build cannot resolve it to a URL.`,
        `Where a foundation is served is the host's to declare, so the build does not guess it.`,
        ``,
        `  • Deploying to another host (\`uniweb deploy --host=<adapter>\`), or taking`,
        `    the build anywhere (\`uniweb export\`)? Declare the served URL in site.yml —`,
        `    the runtime accepts any URL, from any host:`,
        ``,
        `      foundation: https://<host>/<path>/entry.js`,
        ``,
        `    or the object form when the stylesheet sits elsewhere:`,
        ``,
        `      foundation: { url: 'https://…/entry.js', cssUrl: 'https://…/assets/style.css' }`,
        ``,
        `  • Iterating locally?`,
        `    Reference the workspace foundation by package name.`,
        ``,
        `  • Targeting the Uniweb platform?`,
        `    \`uniweb publish\` has the platform resolve the ref — no build-time URL needed.`
      ].join('\n')
    )
  }

  // Versionless scoped names (`@org/name`) are valid as *handles* — they
  // resolve through the local checks below (file: dep,
  // workspace sibling) when the developer is iterating locally on a
  // foundation that will eventually be published as `@org/name@ver`.
  // Tianyu's uniweb.io site uses this shape:
  //   site.yml:     foundation: '@uniweb/io'
  //   package.json: "@uniweb/io": "file:../../foundations/io"
  // The file: dep check below picks it up. If no local resolution exists
  // either, the function throws below with a "missing version" hint.

  // Check if it's a local workspace sibling (directory name matches package name)
  const localPath = resolve(siteRoot, '..', name)
  if (existsSync(localPath)) {
    return {
      type: 'local',
      name,
      path: localPath
    }
  }

  // Check if it's a file: dependency (co-located projects where dir name ≠ package name)
  // e.g. "marketing-foundation": "file:../foundation" in marketing/site/package.json
  try {
    const pkg = JSON.parse(readFileSync(resolve(siteRoot, 'package.json'), 'utf8'))
    const dep = pkg.dependencies?.[name]
    if (dep && dep.startsWith('file:')) {
      const filePath = resolve(siteRoot, dep.slice(5))
      if (existsSync(filePath)) {
        return {
          type: 'local',
          name,
          path: filePath
        }
      }
    }
  } catch {}

  // Check in foundations/ directory (for multi-site projects)
  const foundationsPath = resolve(siteRoot, '..', '..', 'foundations', name)
  if (existsSync(foundationsPath)) {
    return {
      type: 'local',
      name,
      path: foundationsPath
    }
  }

  // Versionless scoped name that didn't resolve locally — likely a typo
  // or a missing file: dep. Give a specific hint distinguishing the two
  // common causes (forgot @version vs. forgot to wire the file: dep).
  if (/^@[a-z0-9_-]+\//.test(name)) {
    throw new Error(
      `site.yml foundation: '${name}' did not resolve to a local source and no version was specified.\n` +
      `If this is a workspace-local foundation, add it to the site's package.json:\n` +
      `  "dependencies": { "${name}": "file:../path/to/foundation" }\n` +
      `If this is a published catalog ref, include the version: '${name}@<version>' (e.g. '${name}@0.1.2').`
    )
  }

  // Foundations are not npm packages. If we get here, the declaration
  // didn't match a workspace sibling, a `file:` dep, a foundations/ entry,
  // a registry ref, or a URL — none of the supported shapes. Fail with
  // guidance rather than fall through to a node_modules lookup that will
  // produce a confusing error later in the build.
  throw new Error(
    `site.yml foundation: '${name}' did not resolve.\n` +
    `Foundations must be one of:\n` +
    `  - a workspace-local sibling (a directory next to the site, named '${name}')\n` +
    `  - a 'file:' dep in the site's package.json\n` +
    `  - a directory in '../../foundations/${name}'\n` +
    `  - a versioned registry ref: '@org/${name}@<version>'\n` +
    `  - a full URL: 'https://...'\n` +
    `Foundations are runtime federated modules, not npm packages — there is no fall-through to node_modules.`
  )
}
