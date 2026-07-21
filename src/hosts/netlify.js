/**
 * Netlify host adapter
 *
 * Shares Cloudflare Pages' `_redirects` emission — the format originated
 * at Netlify and the two hosts read it identically — but owns its own
 * deploy and CI scaffolding, which is why this is a canonical adapter
 * rather than the alias it used to be. (The registry header states the
 * rule: adapters that need to *behave* differently per name become
 * canonical entries, not aliases. `netlify deploy` and `wrangler pages
 * deploy` are different tools with different auth.)
 *
 * deploy: drives the `netlify` CLI with `--json` so the deploy URL comes
 * back structured instead of scraped from human output.
 *
 * initCi: emits a GitHub Actions workflow (push → production deploy) and,
 * opt-in, a pull-request preview workflow using Netlify deploy aliases.
 */

import { DeployError, spawnTool, readCredential, credentialHint } from './deploy-utils.js'
import { emitRedirectsFile } from './cloudflare-pages.js'
import {
  setupSteps,
  uniwebBuildCommand,
  pushTrigger,
  prCommentStep,
  workflowHeader,
} from './ci-workflow.js'

const NETLIFY_INSTALL = [
  'Install the Netlify CLI:',
  '  npm install -g netlify-cli',
  '  # or run it without installing: npx netlify-cli …',
  '',
  'Then authenticate with `netlify login`, or set NETLIFY_AUTH_TOKEN.',
].join('\n')

function translateNetlifyError(code, stderr) {
  const out = stderr.trim()

  if (/Not authorized|401|invalid token|Access Denied/i.test(out)) {
    return new DeployError(
      'Netlify rejected the credentials.',
      {
        hint: credentialHint({
          what: 'a Netlify personal access token',
          envVars: ['NETLIFY_AUTH_TOKEN'],
          docsUrl: 'Create one at https://app.netlify.com/user/applications#personal-access-tokens',
        }),
      }
    )
  }

  if (/site not found|Site not found|404/i.test(out)) {
    return new DeployError(
      'That Netlify site does not exist (or the token cannot see it).',
      {
        hint: [
          'Create it once, or link an existing one:',
          '  netlify sites:create --name my-site',
          '  # or, from the site directory: netlify link',
          '',
          'Then set `siteId` on the target in deploy.yml, or export NETLIFY_SITE_ID.',
        ].join('\n'),
      }
    )
  }

  return null
}

/**
 * Parse `netlify deploy --json` output. The CLI prints a single JSON
 * object; older versions prefix it with progress noise, so scan for the
 * first `{`. Best-effort — a parse miss only costs us the echoed URL.
 */
export function parseNetlifyJson(stdout) {
  const start = stdout.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
}

async function deploy({ distDir, deployConfig = {}, env = process.env, log = () => {} }) {
  const siteId = readCredential(deployConfig, env, 'siteId', 'NETLIFY_SITE_ID')
  if (!siteId) {
    throw new DeployError(
      'Netlify needs a site id.',
      {
        hint: [
          'Add it to the target in deploy.yml:',
          '',
          '  targets:',
          '    production:',
          '      host: netlify',
          '      siteId: 1a2b3c4d-….   # Site settings → General → Site ID',
          '',
          'Or export NETLIFY_SITE_ID. Create a site with `netlify sites:create`.',
        ].join('\n'),
      }
    )
  }

  const subprocessEnv = { ...env }
  if (!env.NETLIFY_AUTH_TOKEN) {
    log('  No NETLIFY_AUTH_TOKEN set — falling back to your `netlify login` session.')
  }

  // --alias produces a named preview deploy; without it (and with --prod)
  // this publishes to the site's production URL.
  const isPreview = !!deployConfig.alias
  const args = ['deploy', `--dir=${distDir}`, `--site=${siteId}`, '--json']
  if (isPreview) {
    args.push(`--alias=${deployConfig.alias}`)
  } else {
    args.push('--prod')
  }
  if (deployConfig.message) args.push(`--message=${deployConfig.message}`)

  log(`\n→ Deploying to Netlify site ${siteId}${isPreview ? ` (preview: ${deployConfig.alias})` : ''}`)
  // --json means stdout is a machine payload; don't echo it as progress.
  const { stdout } = await spawnTool('netlify', args, {
    env: subprocessEnv,
    log,
    install: NETLIFY_INSTALL,
    translate: translateNetlifyError,
    quiet: true,
  })

  const result = parseNetlifyJson(stdout)
  const url = result?.deploy_url || result?.url || null
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
  const build = uniwebBuildCommand({ packageManager, host: 'netlify' })
  const setup = setupSteps({ packageManager, nodeVersion, pnpmVersion })

  const files = [{
    path: '.github/workflows/deploy-netlify.yml',
    content: `${workflowHeader({
      title: 'Deploy to Netlify',
      command: 'uniweb add ci --host=netlify',
      notes: [
        'Requires two repository secrets (Settings → Secrets and variables → Actions):',
        '  NETLIFY_AUTH_TOKEN  — personal access token',
        '  NETLIFY_SITE_ID     — Site settings → General → Site ID',
      ],
    })}

name: Deploy to Netlify

${pushTrigger()}

concurrency:
  group: netlify-production
  cancel-in-progress: true

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    env:
      NETLIFY_AUTH_TOKEN: \${{ secrets.NETLIFY_AUTH_TOKEN }}
      NETLIFY_SITE_ID: \${{ secrets.NETLIFY_SITE_ID }}
    steps:
${setup}
      - run: ${build}
        working-directory: ${sitePath}
      - name: Publish to Netlify
        run: npx netlify-cli deploy --prod --dir=${sitePath}/dist --message="\${{ github.event.head_commit.message }}"
`,
  }]

  if (previews) {
    files.push({
      path: '.github/workflows/preview-netlify.yml',
      content: `${workflowHeader({
        title: 'Preview deploy for pull requests — Netlify',
        command: 'uniweb add ci --host=netlify',
        notes: [
          'Each PR deploys to a named alias (pr-<number>) and the URL is',
          'posted as a comment on the PR.',
          '',
          'No teardown job: Netlify keeps deploys immutable by design and',
          'expires aliases with the site\'s retention policy. Deleting them',
          'per-PR would fight the platform rather than help.',
        ],
      })}

name: Preview (Netlify)

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: netlify-preview-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  preview:
    runs-on: ubuntu-latest
    env:
      NETLIFY_AUTH_TOKEN: \${{ secrets.NETLIFY_AUTH_TOKEN }}
      NETLIFY_SITE_ID: \${{ secrets.NETLIFY_SITE_ID }}
    steps:
${setup}
      - run: ${build}
        working-directory: ${sitePath}
      - name: Publish preview
        id: publish
        run: |
          URL=$(npx netlify-cli deploy \\
            --dir=${sitePath}/dist \\
            --alias=pr-\${{ github.event.pull_request.number }} \\
            --json | jq -r '.deploy_url')
          echo "url=$URL" >> "$GITHUB_OUTPUT"
${prCommentStep({
  urlExpression: '${{ steps.publish.outputs.url }}',
  hostLabel: 'Netlify',
})}
`,
    })
  }

  const targetConfig = { host: 'netlify' }
  if (domain) targetConfig.domain = domain

  const postInstructions = [
    'Create the site once: `netlify sites:create --name <name>` (or link an existing one).',
    'Add two repository secrets under Settings → Secrets and variables → Actions:',
    '  NETLIFY_AUTH_TOKEN  (https://app.netlify.com/user/applications)',
    '  NETLIFY_SITE_ID     (Site settings → General → Site ID)',
    'Commit and push the workflow — the deploy runs on every push to the default branch.',
  ]
  if (previews) {
    postInstructions.push('Pull requests deploy to a pr-<number> alias, commented on the PR.')
  }
  if (domain) {
    postInstructions.push(`Attach ${domain} under Domain management in the Netlify dashboard.`)
  }

  return { files, postInstructions, targetConfig }
}

const adapter = {
  name: 'netlify',
  display: {
    order: 30,
    pushWith: 'the netlify CLI',
    title: 'Netlify',
    qualifier: 'free, CI on push',
    summary: 'Static hosting with deploy previews. Set up a workflow, or upload from here with the netlify CLI.',
    ci: true,
    previews: true,
  },
  async postBuild({ distDir, localeConfigs, onProgress }) {
    // Same _redirects contract as Cloudflare Pages.
    await emitRedirectsFile(distDir, localeConfigs, onProgress)
  },
  deploy,
  initCi,
}

export default adapter
