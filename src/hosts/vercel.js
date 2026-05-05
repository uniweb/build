/**
 * Vercel host adapter
 *
 * Vercel auto-resolves directory-index requests, runs the project's
 * configured build command, and serves whatever lands in the configured
 * output directory (we use `dist/`). The framework has no helper files
 * to drop — postBuild is intentionally empty.
 *
 * Lifecycle: Git-driven. The user sets up Vercel's GitHub integration,
 * configures `npx uniweb build` as the build command, and pushes; Vercel
 * runs the build and serves the result. `uniweb deploy --host=vercel`
 * is intentionally not supported — there is no CLI-push path. See the
 * deploy command's "host adapter does not implement a deploy step" error
 * for the user-facing message when someone tries.
 *
 * `vercel.json` emission is not done by default. Most Vercel projects
 * don't need one (the defaults already handle directory-index, SPA
 * fallback, etc.). Users who need rewrites or custom headers commit
 * their own `vercel.json` next to `site.yml` and the build leaves it
 * alone.
 *
 * Registered as its own canonical adapter (not an alias of
 * generic-static) so the deploy manifest, dry-run output, and
 * deploy.yml's `host:` field record `vercel` literally — readers should
 * see what the user picked, not the canonical implementation behind it.
 */

const adapter = {
  name: 'vercel',
  async postBuild() {
    // Intentionally empty. Vercel's defaults handle directory-index,
    // SPA fallback, and asset caching without per-site config.
  },
}

export default adapter
