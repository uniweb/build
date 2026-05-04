/**
 * GitHub Pages host adapter
 *
 * GitHub Pages auto-resolves directory indexes (so `<route>/index.html`
 * works without a URI rewrite) and serves static files from a repo or
 * branch. The one quirk: by default GH Pages runs Jekyll over the
 * artifact, which silently strips paths whose components start with `_`
 * — including `_pages/`, `_importmap/`, `_redirects`, and assets in
 * `_app/` style directories used by various build pipelines. Dropping a
 * `.nojekyll` file at the site root opts out of Jekyll processing
 * entirely. Without it, parts of the site silently disappear.
 *
 * postBuild: writes `dist/.nojekyll` (empty file).
 *
 * GitHub Pages does not consume `_redirects` (that's a
 * Cloudflare/Netlify thing) — page-level redirects go through the
 * meta-refresh HTML the prerender already emits for `redirect:` /
 * `rewrite:` directives. No deploy hook: users push to the configured
 * branch (`gh-pages` or `main` with /docs) and GitHub serves it.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const adapter = {
  name: 'github-pages',
  async postBuild({ distDir, onProgress = () => {} }) {
    await writeFile(join(distDir, '.nojekyll'), '')
    onProgress('Wrote .nojekyll (opts out of Jekyll on GitHub Pages)')
  },
}

export default adapter
