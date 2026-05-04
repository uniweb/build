/**
 * Generic static host adapter
 *
 * No-op postBuild — useful as a baseline target when the user is
 * deploying to a static host that needs no framework-side helper files
 * (e.g., a self-managed nginx or a host that auto-resolves directory
 * indexes natively).
 *
 * Selecting `host: generic-static` explicitly opts out of the Netlify
 * `_redirects` output. Pages with `redirect:` or `rewrite:` directives
 * still emit their meta-refresh HTML (handled inside prerender.js), so
 * those keep working without host help.
 */

const adapter = {
  name: 'generic-static',
  async postBuild() {
    // Intentionally empty.
  },
}

export default adapter
