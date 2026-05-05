/**
 * CI host context detection
 *
 * Inspects the environment for well-known CI host signals and returns
 * a normalized context object that the build pipeline uses to:
 *   1) Default the host adapter when --host is not passed (e.g.,
 *      VERCEL=1 → 'vercel'). Explicit --host always wins.
 *   2) Stash artifact provenance in the deploy manifest so the on-disk
 *      dist/ is honest about where it was built.
 *
 * The detector is intentionally narrow: only hosts that *imply a
 * deploy target* set the `host` field. GitHub Actions is a CI runner,
 * not a host — a GHA workflow can deploy anywhere, so we never default
 * --host from GITHUB_ACTIONS=true. We do still pick up its branch /
 * sha metadata when no other host signal is present, so the manifest
 * captures what it can.
 *
 * `isProduction` is left null when the host doesn't expose a clean
 * signal — better to be unknown than to invent a heuristic that
 * silently breaks at the next host config change.
 *
 * No dependency on the host registry (which would create a circular
 * import); the returned `host` is just a string. Callers validate it
 * via getAdapter() at use time.
 */

/**
 * @typedef {Object} CiContext
 * @property {string|null} host          Adapter name to default --host to. Null
 *                                       when the runner doesn't imply a target
 *                                       (e.g., bare GitHub Actions).
 * @property {string|null} runner        Free-text label for the CI runner —
 *                                       useful when host is null but we still
 *                                       want to record provenance.
 * @property {string|null} branch
 * @property {string|null} sha
 * @property {boolean|null} isProduction Tri-state: true / false / null (unknown).
 * @property {string|null} publicUrl     Host-assigned URL for this deploy, when
 *                                       known. Useful for sitemap / canonical.
 * @property {string|null} deploymentId
 */

/**
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {CiContext|null} null when no CI host or runner is detected.
 */
export function detectCiContext(env = process.env) {
  if (env.VERCEL === '1') {
    return {
      host: 'vercel',
      runner: 'vercel',
      branch: env.VERCEL_GIT_COMMIT_REF || null,
      sha: env.VERCEL_GIT_COMMIT_SHA || null,
      isProduction: env.VERCEL_ENV ? env.VERCEL_ENV === 'production' : null,
      publicUrl: env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null,
      deploymentId: env.VERCEL_DEPLOYMENT_ID || null,
    }
  }

  if (env.CF_PAGES === '1') {
    return {
      host: 'cloudflare-pages',
      runner: 'cloudflare-pages',
      branch: env.CF_PAGES_BRANCH || null,
      sha: env.CF_PAGES_COMMIT_SHA || null,
      // CF Pages doesn't expose a clean production flag. Branch
      // alone is a heuristic the project's prod-branch config
      // can falsify; leave it null.
      isProduction: null,
      publicUrl: env.CF_PAGES_URL || null,
      deploymentId: null,
    }
  }

  if (env.NETLIFY === 'true') {
    return {
      // Aliased in the registry to cloudflare-pages (same _redirects
      // format), but we record the user-facing name.
      host: 'netlify',
      runner: 'netlify',
      branch: env.BRANCH || null,
      sha: env.COMMIT_REF || null,
      isProduction: env.CONTEXT ? env.CONTEXT === 'production' : null,
      publicUrl: env.DEPLOY_PRIME_URL || env.URL || null,
      deploymentId: env.DEPLOY_ID || null,
    }
  }

  if (env.GITHUB_ACTIONS === 'true') {
    // Runner-only: GHA can deploy anywhere. Don't default --host from this.
    return {
      host: null,
      runner: 'github-actions',
      branch: env.GITHUB_REF_NAME || null,
      sha: env.GITHUB_SHA || null,
      isProduction: null,
      publicUrl: null,
      deploymentId: env.GITHUB_RUN_ID || null,
    }
  }

  return null
}
