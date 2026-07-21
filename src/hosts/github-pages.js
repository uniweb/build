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
 * Two ways to publish, both supported:
 *
 *   - initCi (recommended) — emits a `.github/workflows/…` that runs
 *     `uniweb build --host=github-pages` and uploads via the official
 *     actions/deploy-pages flow. One-time setup; every push deploys.
 *   - deploy — publishes an already-built `dist/` straight to the
 *     `gh-pages` branch from your machine. For repos without Actions
 *     minutes, or a one-off publish. Uses a detached worktree so your
 *     working tree is never touched, and a normal (non-force) commit so
 *     the branch history stays intact and revertible.
 *
 * UNIWEB_BASE is decided at workflow scaffold time based on the deploy
 * target (per gotcha #15 for the base-path flow):
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

import { writeFile, mkdtemp, rm, cp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

import { DeployError, spawnTool } from './deploy-utils.js'
import { setupSteps, uniwebBuildCommand, pushTrigger, workflowHeader } from './ci-workflow.js'

const DEFAULT_PUBLISH_BRANCH = 'gh-pages'

// Only used to seed a brand-new publish branch (`git checkout --orphan`
// requires a name). Always deleted in the deploy's finally block.
const TEMP_BRANCH = 'uniweb-deploy-tmp'

const GIT_INSTALL = [
  'Install git:',
  '  macOS:    xcode-select --install  (or brew install git)',
  '  Linux:    apt install git  /  dnf install git',
  '  Windows:  https://git-scm.com/download/win',
].join('\n')

function git(args, opts) {
  return spawnTool('git', args, { install: GIT_INSTALL, quiet: true, ...opts })
}

/**
 * Publish `distDir` to the repo's publish branch (default `gh-pages`).
 *
 * Mechanics, and why each choice:
 *   - A detached worktree in a temp dir, never the user's working tree.
 *     A deploy must not be able to disturb uncommitted work.
 *   - `git rm -rf .` then copy, so the published tree is an exact mirror
 *     of dist/ and pages deleted locally actually disappear.
 *   - A normal commit + push, never `--force`. History on the publish
 *     branch stays intact, so a bad deploy is one `git revert` away.
 */
async function deploy({ distDir, deployConfig = {}, env = process.env, log = () => {} }) {
  const branch = deployConfig.branch || DEFAULT_PUBLISH_BRANCH
  const remote = deployConfig.remote || 'origin'

  // Must be inside a git repo with the named remote, or there's nothing
  // to publish to.
  let repoRoot
  try {
    const { stdout } = await git(['rev-parse', '--show-toplevel'], { env })
    repoRoot = stdout.trim()
  } catch {
    throw new DeployError(
      'Not inside a git repository.',
      {
        hint: [
          'The github-pages deploy publishes to a branch of your repo, so it needs one.',
          '',
          '  git init && git remote add origin git@github.com:<user>/<repo>.git',
          '',
          'Or use the CI path instead: `uniweb add ci --host=github-pages`.',
        ].join('\n'),
      }
    )
  }

  try {
    await git(['remote', 'get-url', remote], { env, cwd: repoRoot })
  } catch {
    throw new DeployError(
      `This repository has no '${remote}' remote.`,
      {
        hint: [
          `Add one, then retry:`,
          `  git remote add ${remote} git@github.com:<user>/<repo>.git`,
        ].join('\n'),
      }
    )
  }

  const entries = await readdir(distDir).catch(() => [])
  if (!entries.length) {
    throw new DeployError(
      'dist/ is empty — nothing to publish.',
      { hint: 'Run `uniweb build --host=github-pages` first.' }
    )
  }

  log(`\n→ Publishing dist/ to the '${branch}' branch of ${remote}`)

  const worktree = await mkdtemp(join(tmpdir(), 'uniweb-ghpages-'))
  let worktreeAdded = false
  let tempBranchCreated = false
  try {
    // Does the publish branch already exist on the remote?
    let branchExists = true
    try {
      await git(['fetch', remote, branch], { env, cwd: repoRoot })
    } catch {
      branchExists = false
    }

    if (branchExists) {
      // Detached at the remote tip: we commit on top of it without ever
      // creating a local branch ref, so a failed run leaves nothing to
      // clean up and the next attempt isn't blocked by a stale branch.
      await git(['worktree', 'add', '--detach', worktree, `${remote}/${branch}`], { env, cwd: repoRoot })
      worktreeAdded = true
    } else {
      log(`  '${branch}' does not exist yet — creating it.`)
      await git(['worktree', 'add', '--detach', worktree], { env, cwd: repoRoot })
      worktreeAdded = true
      // `--orphan` is the only way to start a history with no parent, and
      // it insists on a branch name. Clear any leftover from a crashed
      // run, then delete ours in the finally block.
      await git(['branch', '-D', TEMP_BRANCH], { env, cwd: repoRoot }).catch(() => {})
      await git(['checkout', '--orphan', TEMP_BRANCH], { env, cwd: worktree })
      tempBranchCreated = true
    }

    // Exact mirror: drop everything tracked, then lay down dist/. Without
    // this, pages deleted locally would linger on the published site.
    await git(['rm', '-rf', '--quiet', '.'], { env, cwd: worktree }).catch(() => {})

    await cp(distDir, worktree, { recursive: true })
    // Belt and braces: postBuild already wrote one, but a dist/ built for
    // a different host wouldn't have it, and without it GH Pages eats
    // every `_`-prefixed path.
    await writeFile(join(worktree, '.nojekyll'), '')

    await git(['add', '-A'], { env, cwd: worktree })

    // Nothing changed → don't create an empty commit.
    try {
      await git(['diff', '--cached', '--quiet'], { env, cwd: worktree })
      log('\n✓ Already up to date — nothing to publish.')
      return { url: null, unchanged: true }
    } catch {
      // Non-zero exit from `diff --quiet` means there ARE staged changes.
    }

    const message = deployConfig.message || `deploy: site build ${new Date().toISOString()}`
    await git(['commit', '-m', message], { env, cwd: worktree })
    const { stdout: head } = await git(['rev-parse', 'HEAD'], { env, cwd: worktree })
    const sha = head.trim()

    // Push the commit BY SHA, from the repo root. Two reasons, both bugs
    // found the hard way: the root is where `remote` is configured (a
    // relative remote path like `../origin.git` resolves only there), and
    // pushing `HEAD` from the root would push the root's HEAD — the
    // developer's working branch — not what the worktree just built.
    await git(['push', remote, `${sha}:refs/heads/${branch}`], { env, cwd: repoRoot, log })

    const url = await inferPagesUrl(repoRoot, remote, env)
    log('\n✓ Published.')
    if (url) {
      log(`  ${url}`)
      log('  (Settings → Pages → Source must be set to "Deploy from a branch")')
    }
    return { url }
  } finally {
    // Order matters: a branch checked out in a worktree can't be deleted.
    if (worktreeAdded) {
      await git(['worktree', 'remove', '--force', worktree], { env, cwd: repoRoot }).catch(() => {})
    }
    if (tempBranchCreated) {
      await git(['branch', '-D', TEMP_BRANCH], { env, cwd: repoRoot }).catch(() => {})
    }
    await rm(worktree, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Derive the public Pages URL from the remote. Best-effort — a miss only
 * costs the echoed link.
 */
async function inferPagesUrl(repoRoot, remote, env) {
  try {
    const { stdout } = await git(['remote', 'get-url', remote], { env, cwd: repoRoot })
    return pagesUrlFromRemote(stdout.trim())
  } catch {
    return null
  }
}

/**
 * Map a GitHub remote URL to the site's public Pages URL.
 *
 * Two repo shapes, served differently: `<user>.github.io` is the profile
 * repo and is served at the domain root; every other repo is served under
 * `/<repo>/`. Non-GitHub remotes yield null — we don't guess.
 *
 * Exported for tests.
 */
export function pagesUrlFromRemote(remoteUrl) {
  const match = String(remoteUrl).match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i)
  if (!match) return null
  const [, owner, repo] = match
  if (/\.github\.io$/i.test(repo)) return `https://${repo.toLowerCase()}/`
  return `https://${owner.toLowerCase()}.github.io/${repo}/`
}

const adapter = {
  name: 'github-pages',

  display: {

    order: 10,

    pushWith: 'git — commits dist/ to the gh-pages branch',
    title: 'GitHub Pages',
    qualifier: 'free, CI on push',
    summary: 'Free static hosting from your repo, with a custom domain over HTTPS. Set up a workflow once and every push deploys.',
    ci: true,
    // Can also publish FOUNDATIONS at permanent versioned URLs
    // (`initCi({ target: 'foundation' })`). No other adapter implements
    // that today, and the CLI gates on this flag rather than silently
    // scaffolding a site workflow for a foundation request.
    foundationCi: true,
    previews: false,
  },

  async postBuild({ distDir, onProgress = () => {} }) {
    await writeFile(join(distDir, '.nojekyll'), '')
    onProgress('Wrote .nojekyll (opts out of Jekyll on GitHub Pages)')
  },

  deploy,

  // `pnpmVersion` is the pnpm major for the generated CI. The CLI passes the
  // authoritative value (versions.js::PNPM_VERSION); the default here is only a
  // fallback for direct/test callers.
  //
  // `target` picks what gets published:
  //   'site'       — the site's dist/ at the Pages root (the common case)
  //   'foundation' — built foundations at versioned, permanent URLs
  //                  (foundations/<name>/<version>/entry.js). The free
  //                  distribution path for a foundation product; sites
  //                  reference the URL from site.yml.
  async initCi({
    site,
    foundations = [],
    target = 'site',
    packageManager = 'pnpm',
    nodeVersion = '20',
    pnpmVersion = '11',
    domain = null,
  }) {
    if (target === 'foundation') {
      return initFoundationCi({ foundations, packageManager, nodeVersion, pnpmVersion })
    }

    const sitePath = site.path
    const workflowPath = `.github/workflows/deploy-github-pages.yml`
    const yaml = renderWorkflow({ sitePath, packageManager, nodeVersion, pnpmVersion, domain })

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

/**
 * Foundation distribution workflow.
 *
 * Publishes each built foundation at `foundations/<name>/<version>/` on
 * the gh-pages branch. Versions accumulate: a bumped version creates a
 * new directory next to the old ones, so every URL a site ever pinned
 * keeps resolving. This is the free alternative to the Uniweb catalog —
 * permanent stable URLs and GitHub's CDN, without propagation or
 * license gating.
 */
function initFoundationCi({ foundations, packageManager, nodeVersion, pnpmVersion }) {
  if (!foundations.length) {
    throw new Error('No foundation found to publish. Add one with `uniweb add foundation` first.')
  }

  const setup = setupSteps({ packageManager, nodeVersion, pnpmVersion })
  const buildCmd = packageManager === 'pnpm' ? 'pnpm build' : 'npm run build'

  // `<public-name>:<dir>` pairs, resolved by the CLI and baked in rather
  // than derived with `basename` at CI time. The name becomes part of a
  // permanent URL that sites pin, so it must not drift when a directory
  // is renamed — and the CLI already printed these exact names in its
  // next-steps output.
  const pairs = foundations.map(f => `${f.name}:${f.path}`)

  const content = `${workflowHeader({
    title: 'Publish foundations to GitHub Pages',
    command: 'uniweb add ci --host=github-pages --foundation',
    notes: [
      'Each foundation is published at a permanent versioned URL:',
      '',
      '  https://<user>.github.io/<repo>/foundations/<name>/<version>/entry.js',
      '',
      'Versions accumulate — bumping package.json version creates a new',
      'directory alongside the old ones, so URLs already pinned by a site',
      'keep resolving forever. Reference one from a site\'s site.yml:',
      '',
      '  foundation: \'https://<user>.github.io/<repo>/foundations/<name>/<version>/entry.js\'',
    ],
  })}

name: Publish Foundations

${pushTrigger()}

permissions:
  contents: write   # writes to the gh-pages branch

concurrency:
  group: publish-foundations
  cancel-in-progress: false

jobs:
  build-and-publish:
    runs-on: ubuntu-latest
    steps:
${setup}
      - name: Build and stage foundations
        shell: bash
        run: |
          set -e
          mkdir -p _staging/foundations
          for pair in ${pairs.map(p => JSON.stringify(p)).join(' ')}; do
            name="\${pair%%:*}"
            dir="\${pair#*:}"
            version=$(jq -r '.version' "$dir/package.json")
            if [ -z "$version" ] || [ "$version" = "null" ]; then
              echo "::warning::skipping $name — no version in package.json"
              continue
            fi

            echo "Building $name@$version"
            (cd "$dir" && ${buildCmd})

            if [ ! -d "$dir/dist" ]; then
              echo "::error::build produced no dist/ for $name"
              exit 1
            fi

            mkdir -p "_staging/foundations/$name/$version"
            cp -R "$dir/dist/." "_staging/foundations/$name/$version/"
            echo "Staged $name@$version"
          done

      - name: Layer onto gh-pages
        shell: bash
        run: |
          set -e
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

          if git fetch origin gh-pages 2>/dev/null; then
            git worktree add _gh-pages gh-pages
          else
            git worktree add --detach _gh-pages
            (cd _gh-pages && git checkout --orphan gh-pages && git rm -rf . 2>/dev/null || true)
          fi

          # Layer, don't replace: older versions must survive so sites
          # pinning them keep working.
          mkdir -p _gh-pages/foundations
          cp -R _staging/foundations/. _gh-pages/foundations/

          # Without this, Jekyll silently 404s every _-prefixed chunk the
          # foundation build emits.
          touch _gh-pages/.nojekyll

          cd _gh-pages
          git add -A
          if git diff --cached --quiet; then
            echo "No foundation changes to publish."
            exit 0
          fi
          git commit -m "publish: foundations from \${GITHUB_SHA::7}"
          git push origin gh-pages
`

  const names = foundations.map(f => f.name)
  return {
    files: [{ path: '.github/workflows/publish-foundations.yml', content }],
    postInstructions: [
      'Commit and push .github/workflows/publish-foundations.yml.',
      'On GitHub: Settings → Pages → Source: "Deploy from a branch" → gh-pages.',
      '',
      'After the first run, each foundation is served at:',
      ...names.map(n => `  https://<user>.github.io/<repo>/foundations/${n}/<version>/entry.js`),
      '',
      'Bump a foundation\'s package.json version to publish a new one; older',
      'versions stay reachable at their original URLs.',
    ],
    targetConfig: null,
  }
}

function renderWorkflow({ sitePath, packageManager, nodeVersion, pnpmVersion, domain }) {
  const isPnpm = packageManager === 'pnpm'
  const setup = setupSteps({ packageManager, nodeVersion, pnpmVersion })
  const buildCmd = uniwebBuildCommand({ packageManager, host: 'github-pages' })

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

  return `${workflowHeader({
    title: 'Deploy to GitHub Pages',
    command: 'uniweb add ci --host=github-pages',
  })}

name: Deploy to GitHub Pages

${pushTrigger()}

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
${setup}
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
