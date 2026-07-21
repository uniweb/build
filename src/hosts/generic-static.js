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
  display: {
    order: 90,
    title: 'Generic static host',
    qualifier: 'no helper files',
    summary: 'A plain dist/ with no host-specific output. Pick this for a self-managed nginx, Caddy, or any host that needs nothing extra.',
    ci: false,
    previews: false,
    // Not a destination in its own right — it names an *artifact shape*,
    // which is the `export --host` question, not "where should this go?".
    // The deploy wizard offers "Somewhere else" instead, which exports.
    wizard: false,
  },
  async postBuild() {
    // Intentionally empty.
  },
}

export default adapter
