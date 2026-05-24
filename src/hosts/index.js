/**
 * Host adapter registry
 *
 * A host adapter encapsulates the framework's knowledge of a specific
 * static-host target: what helper files to drop in `dist/` after a
 * prerender (postBuild), and how to upload + invalidate the result
 * (deploy). One mental home per target.
 *
 * Adapter shape:
 *   {
 *     name: string,                                 // matches deploy.yml targets[*].host
 *     async postBuild({                             // build-time hook
 *       distDir,         // absolute path to dist/
 *       siteContent,     // parsed site-content.json (default locale)
 *       localeConfigs,   // [{locale, contentPath, htmlPath, isDefault, routePrefix}, ...]
 *       ciContext,       // detect-ci-context.js output, or null on local builds
 *       onProgress,      // (msg) => void
 *     }) {},
 *     async deploy({                                // deploy-time hook (optional)
 *       distDir,
 *       deployConfig,    // resolved target's adapter-specific config
 *                        // (bucket, distributionId, region, cacheRules, …)
 *       env,             // process.env
 *       log,             // (msg) => void
 *     }) {},
 *   }
 *
 * postBuild does not receive deployConfig. The build pipeline never
 * reads deploy.yml; only the deploy orchestrator does. If an adapter
 * needs config-aware artifact metadata (e.g., the bucket name baked
 * into a manifest), it can write a placeholder at build time and have
 * its deploy hook augment it with the resolved target before upload.
 * ciContext is universally available so adapters can record artifact
 * provenance (CI host, branch, sha) in their on-disk artifacts.
 *
 * `postBuild` is required. `deploy` is optional — adapters like
 * 'netlify' don't need it (Netlify deploys from git).
 *
 * Deferred (not in V1): user-defined adapters via `deploy.adapter:
 * ./my-adapter.js`. The current registry is a static built-in lookup.
 */

import cloudflarePages from './cloudflare-pages.js'
import githubPages from './github-pages.js'
import genericStatic from './generic-static.js'
import s3Cloudfront from './s3-cloudfront.js'
import vercel from './vercel.js'

const builtins = new Map([
  [cloudflarePages.name, cloudflarePages],
  [githubPages.name, githubPages],
  [genericStatic.name, genericStatic],
  [s3Cloudfront.name, s3Cloudfront],
  [vercel.name, vercel],
])

/**
 * Aliases mapping a user-facing host name to a canonical adapter that
 * already implements the right behavior. Aliases exist when two hosts
 * share an artifact contract (e.g., Netlify and Cloudflare Pages both
 * consume `_redirects` in the same format) — one tested code path,
 * multiple discoverable names.
 *
 * The returned adapter's `name` is rewritten to the *requested* name,
 * so the deploy manifest, dry-run output, and lastDeploy entry record
 * what the user picked. Adapters that need to *behave* differently per
 * name should become canonical entries in `builtins`, not aliases.
 */
const aliases = new Map([
  ['netlify', 'cloudflare-pages'],
])

/**
 * Look up an adapter by name. Throws with the list of known names if
 * the requested adapter doesn't exist.
 *
 * @param {string} name
 * @returns {object} The adapter, with `name` set to the requested value
 *                   even when resolved through an alias.
 */
export function getAdapter(name) {
  const canonicalName = aliases.get(name) || name
  const adapter = builtins.get(canonicalName)
  if (!adapter) {
    const known = listAdapters().join(', ')
    throw new Error(`Unknown deploy host '${name}'. Known: ${known}.`)
  }
  // Preserve the user-facing name when resolving an alias.
  return name === canonicalName ? adapter : { ...adapter, name }
}

/**
 * @returns {string[]} Names of all registered adapters and aliases, sorted.
 *                     Aliases appear alongside canonical names so the
 *                     interactive picker and error messages surface them.
 */
export function listAdapters() {
  return [...builtins.keys(), ...aliases.keys()].sort()
}
