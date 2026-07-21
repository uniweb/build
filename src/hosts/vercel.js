/**
 * Vercel host adapter
 *
 * Vercel auto-resolves directory-index requests and serves whatever lands
 * in the output directory. The framework has no helper files to drop —
 * postBuild is intentionally empty.
 *
 * `vercel.json` emission is not done by default. Most Vercel projects
 * don't need one (the defaults already handle directory-index, SPA
 * fallback, etc.). Users who need rewrites or custom headers commit
 * their own `vercel.json` next to `site.yml` and the build leaves it
 * alone.
 *
 * Two lifecycles are supported, and they're genuinely different:
 *   - Git-driven — connect the repo in Vercel's dashboard and let it
 *     build. Nothing to scaffold.
 *   - CLI-push — `uniweb deploy --host=vercel` uploads an already-built
 *     `dist/` via the `vercel` CLI. This is the path that lets a build
 *     run on your machine (or in a workflow you control) rather than in
 *     Vercel's builder.
 *
 * Registered as its own canonical adapter (not an alias of
 * generic-static) so the deploy manifest, dry-run output, and
 * deploy.yml's `host:` field record `vercel` literally — readers should
 * see what the user picked, not the canonical implementation behind it.
 */

import { DeployError, spawnTool, readCredential, credentialHint } from './deploy-utils.js'
import {
  setupSteps,
  uniwebBuildCommand,
  pushTrigger,
  prCommentStep,
  workflowHeader,
} from './ci-workflow.js'

const VERCEL_INSTALL = [
  'Install the Vercel CLI:',
  '  npm install -g vercel',
  '  # or run it without installing: npx vercel …',
  '',
  'Then authenticate with `vercel login`, or set VERCEL_TOKEN.',
].join('\n')

function translateVercelError(code, stderr) {
  const out = stderr.trim()

  if (/not authorized|Invalid token|forbidden|401/i.test(out)) {
    return new DeployError(
      'Vercel rejected the credentials.',
      {
        hint: credentialHint({
          what: 'a Vercel access token',
          envVars: ['VERCEL_TOKEN'],
          docsUrl: 'Create one at https://vercel.com/account/tokens',
        }),
      }
    )
  }

  if (/Project not found|project does not exist/i.test(out)) {
    return new DeployError(
      'That Vercel project does not exist (or the token cannot see it).',
      {
        hint: [
          'Link the directory to a project once:',
          '  vercel link',
          '',
          'In CI, set VERCEL_ORG_ID and VERCEL_PROJECT_ID instead — both are',
          'written to .vercel/project.json by `vercel link`.',
        ].join('\n'),
      }
    )
  }

  return null
}

/** Last https:// URL printed on stdout is the deployment URL. */
export function extractVercelUrl(stdout) {
  const matches = stdout.match(/https:\/\/\S+\.vercel\.app\S*/g)
  if (!matches || !matches.length) return null
  return matches[matches.length - 1].replace(/[.,)]+$/, '')
}

async function deploy({ distDir, deployConfig = {}, env = process.env, log = () => {} }) {
  const token = readCredential(deployConfig, env, null, 'VERCEL_TOKEN')
  const orgId = readCredential(deployConfig, env, 'orgId', 'VERCEL_ORG_ID')
  const projectId = readCredential(deployConfig, env, 'projectId', 'VERCEL_PROJECT_ID')

  const subprocessEnv = { ...env }
  if (orgId) subprocessEnv.VERCEL_ORG_ID = orgId
  if (projectId) subprocessEnv.VERCEL_PROJECT_ID = projectId
  if (!token && !env.VERCEL_TOKEN) {
    log('  No VERCEL_TOKEN set — falling back to your `vercel login` session.')
  }

  // Deploying a plain directory of static files: Vercel treats it as a
  // static deploy with no build step, which is exactly right — `uniweb
  // build` already produced the artifact.
  const isPreview = deployConfig.preview === true
  const args = ['deploy', distDir, '--yes']
  if (!isPreview) args.push('--prod')
  if (token) args.push(`--token=${token}`)
  if (deployConfig.scope) args.push(`--scope=${deployConfig.scope}`)

  log(`\n→ Deploying to Vercel${isPreview ? ' (preview)' : ''}`)
  const { stdout } = await spawnTool('vercel', args, {
    env: subprocessEnv,
    log,
    install: VERCEL_INSTALL,
    translate: translateVercelError,
  })

  const url = extractVercelUrl(stdout)
  log('\n✓ Deploy complete.')
  if (url) log(`  ${url}`)
  return { url }
}

async function initCi({
  site,
  packageManager = 'pnpm',
  nodeVersion = '20',
  pnpmVersion = '11',
  domain = null,
  previews = true,
}) {
  const sitePath = site.path
  const build = uniwebBuildCommand({ packageManager, host: 'vercel' })
  const setup = setupSteps({ packageManager, nodeVersion, pnpmVersion })

  const files = [{
    path: '.github/workflows/deploy-vercel.yml',
    content: `${workflowHeader({
      title: 'Deploy to Vercel',
      command: 'uniweb add ci --host=vercel',
      notes: [
        'Requires three repository secrets (Settings → Secrets and variables → Actions):',
        '  VERCEL_TOKEN       — https://vercel.com/account/tokens',
        '  VERCEL_ORG_ID      — from .vercel/project.json after `vercel link`',
        '  VERCEL_PROJECT_ID  — same file',
        '',
        'Only needed if you want the build to run here rather than in',
        'Vercel\'s builder. Connecting the repo in the Vercel dashboard is',
        'the zero-config alternative — in that case delete this workflow.',
      ],
    })}

name: Deploy to Vercel

${pushTrigger()}

concurrency:
  group: vercel-production
  cancel-in-progress: true

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    env:
      VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
    steps:
${setup}
      - run: ${build}
        working-directory: ${sitePath}
      - name: Publish to Vercel
        run: npx vercel deploy ${sitePath}/dist --prod --yes --token=\${{ secrets.VERCEL_TOKEN }}
`,
  }]

  if (previews) {
    files.push({
      path: '.github/workflows/preview-vercel.yml',
      content: `${workflowHeader({
        title: 'Preview deploy for pull requests — Vercel',
        command: 'uniweb add ci --host=vercel',
        notes: [
          'Each PR gets a Vercel preview deployment, posted as a comment.',
          '',
          'No teardown job: Vercel manages preview-deployment retention',
          'itself. If the repo is connected to Vercel through the dashboard,',
          'previews already happen natively — delete this workflow instead of',
          'running both.',
        ],
      })}

name: Preview (Vercel)

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: vercel-preview-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  preview:
    runs-on: ubuntu-latest
    env:
      VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
    steps:
${setup}
      - run: ${build}
        working-directory: ${sitePath}
      - name: Publish preview
        id: publish
        run: |
          URL=$(npx vercel deploy ${sitePath}/dist --yes --token=\${{ secrets.VERCEL_TOKEN }})
          echo "url=$URL" >> "$GITHUB_OUTPUT"
${prCommentStep({
  urlExpression: '${{ steps.publish.outputs.url }}',
  hostLabel: 'Vercel',
})}
`,
    })
  }

  const targetConfig = { host: 'vercel' }
  if (domain) targetConfig.domain = domain

  const postInstructions = [
    'Link the project once: `vercel link` (writes .vercel/project.json).',
    'Add three repository secrets under Settings → Secrets and variables → Actions:',
    '  VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID',
    'Commit and push the workflow — the deploy runs on every push to the default branch.',
    '',
    'Alternative: connect the repo in the Vercel dashboard and delete these',
    'workflows. Vercel then builds and previews natively with no secrets.',
  ]
  if (domain) {
    postInstructions.push(`Attach ${domain} under the project's Domains tab.`)
  }

  return { files, postInstructions, targetConfig }
}

const adapter = {
  name: 'vercel',
  display: {
    order: 40,
    pushWith: 'the vercel CLI',
    title: 'Vercel',
    qualifier: 'free tier, CI on push',
    summary: 'Static hosting with native preview deployments. Connect the repo in Vercel\'s dashboard, or upload from here.',
    ci: true,
    previews: true,
  },
  async postBuild() {
    // Intentionally empty. Vercel's defaults handle directory-index,
    // SPA fallback, and asset caching without per-site config.
  },
  deploy,
  initCi,
}

export default adapter
