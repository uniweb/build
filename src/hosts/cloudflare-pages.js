/**
 * Cloudflare Pages host adapter
 *
 * postBuild: emits a `_redirects` file describing redirect/rewrite
 * directives the host evaluates at request time. This is the format
 * Cloudflare Pages uses and is also accepted unchanged by Netlify (the
 * format originated there and the two hosts are compatible at this
 * layer) — `netlify.js` reuses `emitRedirectsFile` for exactly that
 * reason. The two are separate adapters because they *deploy*
 * differently, which is the line the registry header draws.
 *
 * Format: `source destination status`
 *   302 = redirect (browser URL changes)
 *   200 = rewrite/proxy (browser URL stays, host proxies transparently)
 *
 * Translates `redirect:` and `rewrite:` declarations from page.yml.
 * Preserves any `_redirects` the developer authored manually by appending.
 *
 * This is the framework's historical default postBuild output and remains
 * the default when no `--host` flag is passed to `uniweb build`.
 *
 * deploy: drives `wrangler pages deploy`. Needs a project name (from the
 * deploy.yml target) and a Cloudflare API token + account id from the
 * environment.
 *
 * initCi: emits a GitHub Actions workflow that builds and deploys on
 * every push, plus (opt-in) a pull-request preview workflow.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { DeployError, spawnTool, readCredential, credentialHint } from './deploy-utils.js'
import {
  setupSteps,
  uniwebBuildCommand,
  pushTrigger,
  prCommentStep,
  workflowHeader,
} from './ci-workflow.js'

const WRANGLER_INSTALL = [
  'Install wrangler (Cloudflare\'s CLI):',
  '  npm install -g wrangler',
  '  # or run it without installing: npx wrangler …',
  '',
  'Then authenticate with `wrangler login`, or set CLOUDFLARE_API_TOKEN.',
].join('\n')

/**
 * Build the `_redirects` body from per-locale page metadata.
 *
 * @param {Array<{contentPath: string, routePrefix: string}>} localeConfigs
 * @returns {Promise<string[]>} Routing entries (one per line).
 */
async function collectRoutingEntries(localeConfigs) {
  const entries = []
  for (const localeConfig of localeConfigs) {
    const siteContent = JSON.parse(await readFile(localeConfig.contentPath, 'utf8'))
    const prefix = localeConfig.routePrefix || ''
    for (const page of siteContent.pages || []) {
      if (page.redirect) {
        entries.push(`${prefix}${page.route} ${page.redirect} 302`)
      }
      if (page.rewrite) {
        entries.push(`${prefix}${page.route}/* ${page.rewrite}/:splat 200`)
      }
    }
  }
  return entries
}

/**
 * Emit `dist/_redirects` if any redirect/rewrite directives exist.
 *
 * Standalone export retained so internal callers (and tests) can drive
 * the file emission without instantiating the full adapter shape.
 *
 * @param {string} distDir
 * @param {Array} localeConfigs - Output of discoverLocaleContents().
 * @param {function} [onProgress] - Optional progress logger.
 * @returns {Promise<{written: boolean, count: number}>}
 */
export async function emitRedirectsFile(distDir, localeConfigs, onProgress = () => {}) {
  const entries = await collectRoutingEntries(localeConfigs)
  if (entries.length === 0) return { written: false, count: 0 }

  const redirectsPath = join(distDir, '_redirects')
  // Append to existing _redirects if the developer maintains one.
  const existing = existsSync(redirectsPath) ? await readFile(redirectsPath, 'utf8') : ''
  const generated = `# Auto-generated from page.yml redirect: and rewrite: declarations\n${entries.join('\n')}\n`
  await writeFile(redirectsPath, existing ? `${existing.trimEnd()}\n\n${generated}` : generated)
  onProgress(`Generated _redirects (${entries.length} entries)`)
  return { written: true, count: entries.length }
}

/**
 * Pull the deployment URL out of wrangler's output. Wrangler prints a
 * line like "✨ Deployment complete! Take a peek over at https://….pages.dev".
 * Best-effort — a miss just means we don't echo the URL.
 */
export function extractPagesUrl(stdout) {
  const match = stdout.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev\S*/i)
    || stdout.match(/https:\/\/[a-z0-9-]+\.pages\.dev\S*/i)
  return match ? match[0].replace(/[.,)]+$/, '') : null
}

function translateWranglerError(code, stderr) {
  const out = stderr.trim()

  if (/Authentication error|\[code: 10000\]|not authenticated/i.test(out)) {
    return new DeployError(
      'Cloudflare rejected the credentials.',
      {
        hint: credentialHint({
          what: 'a Cloudflare API token with the "Cloudflare Pages — Edit" permission',
          envVars: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
          docsUrl: 'Create one at https://dash.cloudflare.com/profile/api-tokens',
        }),
      }
    )
  }

  if (/Project not found|could not find project/i.test(out)) {
    return new DeployError(
      'That Cloudflare Pages project does not exist.',
      {
        hint: [
          'Create it once (either is fine):',
          '  wrangler pages project create <name>',
          '  # or via the dashboard: Workers & Pages → Create → Pages',
          '',
          'Then set `projectName` on the target in deploy.yml.',
        ].join('\n'),
      }
    )
  }

  return null
}

async function deploy({ distDir, deployConfig = {}, env = process.env, log = () => {} }) {
  const projectName = deployConfig.projectName || deployConfig.project
  if (!projectName) {
    throw new DeployError(
      'Cloudflare Pages needs a project name.',
      {
        hint: [
          'Add it to the target in deploy.yml:',
          '',
          '  targets:',
          '    production:',
          '      host: cloudflare-pages',
          '      projectName: my-site',
          '',
          'The project must already exist — `wrangler pages project create my-site`.',
        ].join('\n'),
      }
    )
  }

  const token = readCredential(deployConfig, env, null, 'CLOUDFLARE_API_TOKEN')
  const accountId = readCredential(deployConfig, env, 'accountId', 'CLOUDFLARE_ACCOUNT_ID')

  // wrangler can also use an interactive `wrangler login` session, so a
  // missing token is not fatal — only warn when neither is present.
  const subprocessEnv = { ...env }
  if (accountId) subprocessEnv.CLOUDFLARE_ACCOUNT_ID = accountId
  if (!token && !env.CLOUDFLARE_API_TOKEN) {
    log('  No CLOUDFLARE_API_TOKEN set — falling back to your `wrangler login` session.')
  }

  const args = ['pages', 'deploy', distDir, `--project-name=${projectName}`]
  if (deployConfig.branch) args.push(`--branch=${deployConfig.branch}`)
  if (deployConfig.commitDirty !== false) args.push('--commit-dirty=true')

  log(`\n→ Deploying to Cloudflare Pages project '${projectName}'`)
  const { stdout } = await spawnTool('wrangler', args, {
    env: subprocessEnv,
    log,
    install: WRANGLER_INSTALL,
    translate: translateWranglerError,
  })

  const url = extractPagesUrl(stdout)
  log('\n✓ Deploy complete.')
  if (url) log(`  ${url}`)
  return { url }
}

/**
 * Scaffold GitHub Actions workflows for Cloudflare Pages.
 *
 * Cloudflare Pages can also build from a dashboard-connected repo, but a
 * committed workflow is the reproducible option: the build runs with the
 * project's own toolchain versions and the same `uniweb build` invocation
 * a developer runs locally.
 */
async function initCi({
  site,
  packageManager = 'pnpm',
  nodeVersion = '20',
  pnpmVersion = '11',
  domain = null,
  projectName = null,
  previews = true,
}) {
  const sitePath = site.path
  const project = projectName || site.name
  const build = uniwebBuildCommand({ packageManager, host: 'cloudflare-pages' })
  const setup = setupSteps({ packageManager, nodeVersion, pnpmVersion })

  const files = [{
    path: '.github/workflows/deploy-cloudflare-pages.yml',
    content: `${workflowHeader({
      title: 'Deploy to Cloudflare Pages',
      command: 'uniweb add ci --host=cloudflare-pages',
      notes: [
        'Requires two repository secrets (Settings → Secrets and variables → Actions):',
        '  CLOUDFLARE_API_TOKEN   — token with the "Cloudflare Pages — Edit" permission',
        '  CLOUDFLARE_ACCOUNT_ID  — found in the Cloudflare dashboard sidebar',
      ],
    })}

name: Deploy to Cloudflare Pages

${pushTrigger()}

concurrency:
  group: cloudflare-pages-production
  cancel-in-progress: true

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
${setup}
      - run: ${build}
        working-directory: ${sitePath}
      - name: Publish to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy ${sitePath}/dist --project-name=${project} --branch=main
`,
  }]

  if (previews) {
    files.push({
      path: '.github/workflows/preview-cloudflare-pages.yml',
      content: `${workflowHeader({
        title: 'Preview deploy for pull requests — Cloudflare Pages',
        command: 'uniweb add ci --host=cloudflare-pages',
        notes: [
          'Each PR gets its own preview URL, posted as a comment on the PR.',
          '',
          'No teardown job: Cloudflare owns preview-deployment lifecycle and',
          'retires them on its own schedule. A delete step here would need to',
          'track deployment ids across runs for no real benefit.',
        ],
      })}

name: Preview (Cloudflare Pages)

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: cloudflare-pages-preview-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
${setup}
      - run: ${build}
        working-directory: ${sitePath}
      - name: Publish preview
        id: publish
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy ${sitePath}/dist --project-name=${project} --branch=pr-\${{ github.event.pull_request.number }}
${prCommentStep({
  urlExpression: '${{ steps.publish.outputs.deployment-url }}',
  hostLabel: 'Cloudflare Pages',
})}
`,
    })
  }

  const targetConfig = { host: 'cloudflare-pages', projectName: project }
  if (domain) targetConfig.domain = domain

  const postInstructions = [
    `Create the Pages project once: \`wrangler pages project create ${project}\``,
    'Add two repository secrets under Settings → Secrets and variables → Actions:',
    '  CLOUDFLARE_API_TOKEN   (Cloudflare Pages — Edit)',
    '  CLOUDFLARE_ACCOUNT_ID',
    'Commit and push the workflow — the deploy runs on every push to the default branch.',
  ]
  if (previews) {
    postInstructions.push('Pull requests get their own preview URL, commented on the PR.')
  }
  if (domain) {
    postInstructions.push(`Attach ${domain} in the Pages project's Custom domains tab.`)
  }

  return { files, postInstructions, targetConfig }
}

const adapter = {
  name: 'cloudflare-pages',
  display: {
    order: 20,
    pushWith: 'wrangler',
    title: 'Cloudflare Pages',
    qualifier: 'free, CI on push',
    summary: 'Unlimited-bandwidth static hosting on Cloudflare\'s CDN. Set up a workflow, or upload from here with wrangler.',
    ci: true,
    previews: true,
  },
  async postBuild({ distDir, localeConfigs, onProgress }) {
    await emitRedirectsFile(distDir, localeConfigs, onProgress)
  },
  deploy,
  initCi,
}

export default adapter
