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
 *
 * `postBuild` is required. `deploy` is optional — adapters like
 * 'netlify' don't need it (Netlify deploys from git).
 *
 * See kb/framework/plans/static-host-deploy-adapters.md for the design.
 * Deferred (not in V1): user-defined adapters via `deploy.adapter:
 * ./my-adapter.js`. The current registry is a static built-in lookup.
 */

import cloudflarePages from './cloudflare-pages.js'
import githubPages from './github-pages.js'
import genericStatic from './generic-static.js'
import s3Cloudfront from './s3-cloudfront.js'

const builtins = new Map([
  [cloudflarePages.name, cloudflarePages],
  [githubPages.name, githubPages],
  [genericStatic.name, genericStatic],
  [s3Cloudfront.name, s3Cloudfront],
])

/**
 * Look up an adapter by name. Throws with the list of known names if
 * the requested adapter doesn't exist.
 *
 * @param {string} name
 * @returns {object} The adapter.
 */
export function getAdapter(name) {
  const adapter = builtins.get(name)
  if (!adapter) {
    const known = [...builtins.keys()].sort().join(', ')
    throw new Error(`Unknown deploy host '${name}'. Known: ${known}.`)
  }
  return adapter
}

/**
 * @returns {string[]} Names of all registered adapters, sorted.
 */
export function listAdapters() {
  return [...builtins.keys()].sort()
}
