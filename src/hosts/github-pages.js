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
 * `rewrite:` directives.
 *
 * initCi: emits a `.github/workflows/deploy-github-pages.yml` that runs
 * `uniweb build --host=github-pages` and uploads the resulting `dist/`
 * via the official actions/deploy-pages flow. UNIWEB_BASE is decided
 * at workflow scaffold time based on the deploy target (per gotcha #15
 * for the base-path flow):
 *
 *   - With `domain`: bakes `UNIWEB_BASE: /` and emits a CNAME file under
 *     `<sitePath>/public/`. GitHub Pages serves the custom domain at
 *     root, so no `/repo/` prefix.
 *   - Without `domain`: derives UNIWEB_BASE from the GitHub repo name at
 *     workflow runtime. A small bash block special-cases the
 *     `<user>.github.io` profile-repo shape (served at root).
 *
 * site.yml stays clean either way — UNIWEB_BASE only kicks in for this
 * deploy target.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const adapter = {
  name: 'github-pages',

  async postBuild({ distDir, onProgress = () => {} }) {
    await writeFile(join(distDir, '.nojekyll'), '')
    onProgress('Wrote .nojekyll (opts out of Jekyll on GitHub Pages)')
  },

  async initCi({ site, packageManager = 'pnpm', nodeVersion = '20', domain = null }) {
    const sitePath = site.path
    const workflowPath = `.github/workflows/deploy-github-pages.yml`
    const yaml = renderWorkflow({ sitePath, packageManager, nodeVersion, domain })

    const files = [{ path: workflowPath, content: yaml }]
    if (domain) {
      // CNAME goes under public/ so Vite copies it into dist/ on every
      // build. GitHub Pages reads dist/CNAME on each deploy to keep the
      // custom domain configured (otherwise the Settings → Pages UI
      // forgets it on subsequent deploys).
      files.push({
        path: `${sitePath}/public/CNAME`,
        content: `${domain}\n`,
      })
    }

    const postInstructions = domain
      ? [
          `Commit and push ${workflowPath} and ${sitePath}/public/CNAME.`,
          `On GitHub: Settings → Pages → Source: GitHub Actions.`,
          `Point your DNS at GitHub Pages (CNAME → <user>.github.io, or A records).`,
          `The deploy runs automatically on every push to the default branch.`,
        ]
      : [
          `Commit and push ${workflowPath} to your repo's default branch.`,
          `On GitHub: Settings → Pages → Source: GitHub Actions.`,
          `The deploy runs automatically on every push to that branch.`,
          ``,
          `Note: the workflow derives UNIWEB_BASE from the repo name at build`,
          `time (e.g., /<repo>/) so site.yml stays clean. For a custom domain,`,
          `re-run with --domain=<your-domain.com> to switch to root-served mode.`,
        ]

    // Adapter-specific config persisted into deploy.yml under
    // `targets.github-pages`. Captures the developer's intent (host +
    // optional custom domain) so re-running `add ci` later can read the
    // remembered domain instead of asking again. host is required; the
    // rest is up to each adapter.
    const targetConfig = { host: 'github-pages' }
    if (domain) targetConfig.domain = domain

    return { files, postInstructions, targetConfig }
  },
}

function renderWorkflow({ sitePath, packageManager, nodeVersion, domain }) {
  const isPnpm = packageManager === 'pnpm'
  const setupSteps = isPnpm
    ? `      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: '${nodeVersion}'
          cache: pnpm
      - run: pnpm install --frozen-lockfile`
    : `      - uses: actions/setup-node@v4
        with:
          node-version: '${nodeVersion}'
          cache: npm
      - run: npm ci`

  const buildCmd = isPnpm
    ? 'pnpm exec uniweb build --host=github-pages'
    : 'npx uniweb build --host=github-pages'

  // Two shapes:
  //   - Custom domain: UNIWEB_BASE is hardcoded to '/' (GH Pages serves
  //     the custom domain at root).
  //   - Project repo: derive UNIWEB_BASE from the repo name. The bash
  //     block special-cases the <user>.github.io profile-repo shape
  //     (also served at root).
  const baseStep = domain
    ? `      - run: ${buildCmd}
        env:
          UNIWEB_BASE: /`
    : `      - name: Resolve UNIWEB_BASE for this repo shape
        run: |
          REPO='\${{ github.event.repository.name }}'
          if [[ "$REPO" == *.github.io ]]; then
            echo "UNIWEB_BASE=/" >> $GITHUB_ENV
          else
            echo "UNIWEB_BASE=/$REPO/" >> $GITHUB_ENV
          fi
      - run: ${buildCmd}`

  return `# Deploy to GitHub Pages
# Generated by \`uniweb add ci --host=github-pages\`. Safe to edit.

name: Deploy to GitHub Pages

on:
  push:
    # Both names are listed so the workflow fires whether the repo
    # uses 'main' (GitHub's current default) or 'master' (older repos
    # and any not migrated). GHA only triggers on a branch that exists,
    # so the unused name is a harmless no-op. Users on a different
    # default (trunk, develop, release) edit this list directly.
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
${setupSteps}
${baseStep}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${sitePath}/dist
      - id: deployment
        uses: actions/deploy-pages@v4
`
}

export default adapter
