/**
 * Tests for the host adapter registry and the V1 built-in adapters.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { load as loadYaml } from 'js-yaml'

import { getAdapter, listAdapters } from '../src/hosts/index.js'
import { emitRedirectsFile } from '../src/hosts/cloudflare-pages.js'
import { pagesUrlFromRemote } from '../src/hosts/github-pages.js'

describe('host registry', () => {
  test('lists built-in adapter names and aliases sorted', () => {
    const names = listAdapters()
    expect(names).toEqual([
      'cloudflare-pages',
      'generic-static',
      'github-pages',
      'netlify',
      's3-cloudfront',
      'vercel',
    ])
  })

  test('getAdapter returns the named adapter', () => {
    expect(getAdapter('cloudflare-pages').name).toBe('cloudflare-pages')
    expect(getAdapter('github-pages').name).toBe('github-pages')
    expect(getAdapter('generic-static').name).toBe('generic-static')
    expect(getAdapter('s3-cloudfront').name).toBe('s3-cloudfront')
    expect(getAdapter('vercel').name).toBe('vercel')
  })

  test('getAdapter throws on unknown name with the full list of known names', () => {
    expect(() => getAdapter('nope')).toThrow(/Unknown deploy host 'nope'/)
    expect(() => getAdapter('nope')).toThrow(
      /cloudflare-pages, generic-static, github-pages, netlify, s3-cloudfront, vercel/
    )
  })

  test('every adapter has the required interface', () => {
    for (const name of listAdapters()) {
      const adapter = getAdapter(name)
      expect(typeof adapter.name).toBe('string')
      expect(adapter.name).toBe(name)
      expect(typeof adapter.postBuild).toBe('function')
      // deploy is optional
      if (adapter.deploy !== undefined) {
        expect(typeof adapter.deploy).toBe('function')
      }
    }
  })

  test('netlify is canonical, not an alias of cloudflare-pages', () => {
    // The two share the `_redirects` contract, so netlify reuses
    // emitRedirectsFile — but they deploy with different CLIs and
    // different auth, so each owns its own adapter. See the registry
    // header: behavior divergence promotes an alias to canonical.
    const netlify = getAdapter('netlify')
    const cfPages = getAdapter('cloudflare-pages')
    expect(netlify.name).toBe('netlify')
    expect(netlify.postBuild).not.toBe(cfPages.postBuild)
    expect(netlify.deploy).not.toBe(cfPages.deploy)
  })

  test('every adapter carries display metadata for the deploy wizard', () => {
    for (const name of listAdapters()) {
      const { display } = getAdapter(name)
      expect(display, `${name} is missing display metadata`).toBeTruthy()
      expect(typeof display.title).toBe('string')
      expect(typeof display.qualifier).toBe('string')
      expect(typeof display.summary).toBe('string')
      expect(typeof display.ci).toBe('boolean')
    }
  })

  test('every adapter advertising ci implements initCi', () => {
    for (const name of listAdapters()) {
      const adapter = getAdapter(name)
      if (adapter.display?.ci) {
        expect(typeof adapter.initCi, `${name} claims ci but has no initCi`).toBe('function')
      }
    }
  })

  test('every adapter offered by the wizard can actually be acted on', () => {
    // The bug this locks out: the picker used to list all six adapters
    // while only s3-cloudfront could deploy, so five of six choices
    // dead-ended. Anything the wizard offers must support at least one
    // of deploy / initCi.
    for (const name of listAdapters()) {
      const adapter = getAdapter(name)
      if (adapter.display?.wizard === false) continue
      const actionable = typeof adapter.deploy === 'function' || typeof adapter.initCi === 'function'
      expect(actionable, `${name} is offered by the wizard but has neither deploy nor initCi`).toBe(true)
    }
  })
})

describe('vercel adapter', () => {
  test('postBuild is a no-op (Vercel handles directory-index natively)', async () => {
    // Importing makeAdapter would be overkill; just call it.
    await expect(getAdapter('vercel').postBuild({})).resolves.toBeUndefined()
  })

  test('implements a CLI-push deploy hook', () => {
    expect(typeof getAdapter('vercel').deploy).toBe('function')
  })
})

describe('cloudflare-pages adapter', () => {
  let distDir

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), 'uniweb-hosts-'))
  })

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true })
  })

  /**
   * Build a localeConfigs entry by writing a site-content.json with
   * the given pages and returning the {contentPath, routePrefix} shape
   * the adapter expects.
   */
  async function makeLocale(prefix, pages, fileName = 'site-content.json') {
    const contentPath = join(distDir, fileName)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(contentPath, JSON.stringify({ pages }))
    return { contentPath, routePrefix: prefix }
  }

  test('writes nothing when no redirect/rewrite directives exist', async () => {
    const localeConfigs = [await makeLocale('', [
      { route: '/about' },
      { route: '/pricing' },
    ])]
    const result = await emitRedirectsFile(distDir, localeConfigs)
    expect(result).toEqual({ written: false, count: 0 })
    expect(existsSync(join(distDir, '_redirects'))).toBe(false)
  })

  test('emits redirect (302) and rewrite (200) entries', async () => {
    const localeConfigs = [await makeLocale('', [
      { route: '/old', redirect: '/new' },
      { route: '/proxied', rewrite: 'https://upstream.example' },
    ])]
    const result = await emitRedirectsFile(distDir, localeConfigs)
    expect(result).toEqual({ written: true, count: 2 })

    const body = await readFile(join(distDir, '_redirects'), 'utf8')
    expect(body).toContain('/old /new 302')
    expect(body).toContain('/proxied/* https://upstream.example/:splat 200')
  })

  test('prefixes entries with the locale routePrefix for non-default locales', async () => {
    const en = await makeLocale('', [
      { route: '/old', redirect: '/new' },
    ])
    const fr = await makeLocale('/fr', [
      { route: '/old', redirect: '/new' },
    ], 'fr-content.json')
    const result = await emitRedirectsFile(distDir, [en, fr])
    expect(result.count).toBe(2)

    const body = await readFile(join(distDir, '_redirects'), 'utf8')
    expect(body).toMatch(/^\/old \/new 302$/m)
    expect(body).toMatch(/^\/fr\/old \/new 302$/m)
  })

  test('preserves a hand-authored _redirects by appending', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(distDir, '_redirects'), '# hand-authored\n/legacy /home 301\n')

    const localeConfigs = [await makeLocale('', [
      { route: '/old', redirect: '/new' },
    ])]
    await emitRedirectsFile(distDir, localeConfigs)

    const body = await readFile(join(distDir, '_redirects'), 'utf8')
    expect(body).toContain('# hand-authored')
    expect(body).toContain('/legacy /home 301')
    expect(body).toContain('/old /new 302')
    // Hand-authored content comes first.
    expect(body.indexOf('/legacy')).toBeLessThan(body.indexOf('/old /new'))
  })

  test('adapter.postBuild delegates to emitRedirectsFile', async () => {
    const localeConfigs = [await makeLocale('', [
      { route: '/old', redirect: '/new' },
    ])]
    const adapter = getAdapter('cloudflare-pages')
    await adapter.postBuild({ distDir, localeConfigs, onProgress: () => {} })
    const body = await readFile(join(distDir, '_redirects'), 'utf8')
    expect(body).toContain('/old /new 302')
  })
})

describe('github-pages adapter', () => {
  let distDir

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), 'uniweb-hosts-'))
  })

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true })
  })

  test('postBuild writes an empty .nojekyll at the dist root', async () => {
    const adapter = getAdapter('github-pages')
    await adapter.postBuild({ distDir, onProgress: () => {} })
    const path = join(distDir, '.nojekyll')
    expect(existsSync(path)).toBe(true)
    const body = await readFile(path, 'utf8')
    expect(body).toBe('')
  })

  test('implements a deploy hook (publishes dist/ to the gh-pages branch)', () => {
    // CI (initCi) remains the recommended path; this is the escape hatch
    // for repos without Actions minutes, or a one-off publish.
    expect(typeof getAdapter('github-pages').deploy).toBe('function')
  })

  test('deploy refuses an empty dist/ rather than pushing an empty branch', async () => {
    const adapter = getAdapter('github-pages')
    await expect(
      adapter.deploy({ distDir, deployConfig: {}, env: process.env, log: () => {} })
    ).rejects.toMatchObject({ name: 'DeployError' })
  })

  describe('initCi', () => {
    const adapter = getAdapter('github-pages')

    test('returns one workflow file at .github/workflows/deploy-github-pages.yml', async () => {
      const result = await adapter.initCi({
        rootDir: '/fake/root',
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
        nodeVersion: '20',
      })
      expect(result.files).toHaveLength(1)
      expect(result.files[0].path).toBe('.github/workflows/deploy-github-pages.yml')
      expect(result.postInstructions.length).toBeGreaterThan(0)
    })

    test('workflow runs uniweb build with --host=github-pages and uploads <sitePath>/dist', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'sites/marketing' },
        packageManager: 'pnpm',
      })
      const yaml = result.files[0].content
      expect(yaml).toContain('pnpm exec uniweb build --host=github-pages')
      expect(yaml).toContain('path: sites/marketing/dist')
    })

    test('workflow derives UNIWEB_BASE from the GitHub repo name (keeps site.yml clean)', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
      })
      const yaml = result.files[0].content
      // Without --domain, UNIWEB_BASE is computed at workflow runtime
      // from the GitHub repo name.
      expect(yaml).toContain("REPO='${{ github.event.repository.name }}'")
      expect(yaml).toContain('UNIWEB_BASE=/$REPO/')
    })

    test('npm package manager produces an npm-shaped workflow (npx + npm ci)', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'npm',
      })
      const yaml = result.files[0].content
      expect(yaml).toContain('npx uniweb build --host=github-pages')
      expect(yaml).toContain('npm ci')
      expect(yaml).not.toContain('pnpm')
    })

    test('uses the supplied node version in the setup-node step', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
        nodeVersion: '22',
      })
      expect(result.files[0].content).toContain("node-version: '22'")
    })

    test('pins pnpm/action-setup to the supplied pnpm version', async () => {
      // Non-default value (adapter default is the current major) proves the
      // value threads through rather than falling back to the default.
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
        pnpmVersion: '10',
      })
      expect(result.files[0].content).toContain('version: 10')
    })

    test('without --domain: includes auto-detect for <user>.github.io profile repos', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
      })
      const yaml = result.files[0].content
      expect(yaml).toContain('Resolve UNIWEB_BASE for this repo shape')
      expect(yaml).toContain('*.github.io')
      expect(yaml).toContain('UNIWEB_BASE=/$REPO/')
      // No CNAME file when --domain is not passed
      expect(result.files.some(f => f.path.endsWith('CNAME'))).toBe(false)
    })

    test('with --domain: bakes UNIWEB_BASE=/ and emits a CNAME file', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
        domain: 'mysite.com',
      })
      const workflow = result.files.find(f => f.path.endsWith('.yml'))
      const cname = result.files.find(f => f.path.endsWith('CNAME'))

      expect(workflow.content).toContain('UNIWEB_BASE: /')
      expect(workflow.content).not.toContain('Resolve UNIWEB_BASE')
      expect(workflow.content).not.toContain('github.event.repository.name')

      expect(cname).toBeDefined()
      expect(cname.path).toBe('site/public/CNAME')
      expect(cname.content).toBe('mysite.com\n')
    })

    test('with --domain: postInstructions mention DNS', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
        domain: 'mysite.com',
      })
      expect(result.postInstructions.join(' ')).toMatch(/DNS/)
    })

    test('triggers on push to main or master (covers older repos)', async () => {
      const result = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
      })
      const yaml = result.files[0].content
      // Listing both names handles the main/master default-branch
      // divergence without a CLI flag. GHA only fires on branches that
      // actually exist, so the unused name is a harmless no-op.
      expect(yaml).toMatch(/branches:\s*\[main, master\]/)
    })

    test('returns targetConfig for deploy.yml persistence', async () => {
      const noDomain = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
      })
      expect(noDomain.targetConfig).toEqual({ host: 'github-pages' })

      const withDomain = await adapter.initCi({
        site: { name: 'my-site', path: 'site' },
        packageManager: 'pnpm',
        domain: 'mysite.com',
      })
      expect(withDomain.targetConfig).toEqual({
        host: 'github-pages',
        domain: 'mysite.com',
      })
    })
  })
})

describe('generic-static adapter', () => {
  test('postBuild is a no-op (writes nothing)', async () => {
    const distDir = await mkdtemp(join(tmpdir(), 'uniweb-hosts-'))
    try {
      const adapter = getAdapter('generic-static')
      await adapter.postBuild({ distDir, localeConfigs: [], onProgress: () => {} })
      // No files emitted.
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(distDir)
      expect(entries).toEqual([])
    } finally {
      await rm(distDir, { recursive: true, force: true })
    }
  })

  test('has no deploy function (Netlify-style auto-deploy or DIY)', () => {
    expect(getAdapter('generic-static').deploy).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * CI scaffolding across every ci-capable adapter                     *
 * ------------------------------------------------------------------ */

describe('initCi across adapters', () => {
  const CI_HOSTS = ['github-pages', 'cloudflare-pages', 'netlify', 'vercel']
  const site = { name: 'acme-www', path: 'sites/marketing' }

  test('every ci-capable adapter emits parseable YAML for both package managers', async () => {
    for (const host of CI_HOSTS) {
      for (const packageManager of ['pnpm', 'npm']) {
        const result = await getAdapter(host).initCi({
          rootDir: '/fake/root', site, packageManager, nodeVersion: '20', pnpmVersion: '11',
        })
        for (const file of result.files) {
          if (!file.path.endsWith('.yml')) continue
          expect(
            () => loadYaml(file.content),
            `${host}/${packageManager} emitted invalid YAML at ${file.path}`
          ).not.toThrow()
        }
      }
    }
  })

  test('every ci-capable adapter builds with its own --host flag', async () => {
    for (const host of CI_HOSTS) {
      const result = await getAdapter(host).initCi({ site, packageManager: 'pnpm' })
      const workflow = result.files.find(f => f.path.includes('deploy-'))
      expect(workflow.content, `${host} workflow`).toContain(`uniweb build --host=${host}`)
    }
  })

  test('adapters advertising previews emit a PR-preview workflow; others do not', async () => {
    for (const host of CI_HOSTS) {
      const adapter = getAdapter(host)
      const result = await adapter.initCi({ site, packageManager: 'pnpm', previews: true })
      const preview = result.files.find(f => f.path.includes('preview-'))
      if (adapter.display.previews) {
        expect(preview, `${host} advertises previews but emitted none`).toBeTruthy()
        expect(preview.content).toContain('pull_request')
        expect(preview.content).toContain('pull-requests: write')
      } else {
        expect(preview, `${host} emitted a preview workflow it does not advertise`).toBeFalsy()
      }
    }
  })

  test('previews:false suppresses the preview workflow', async () => {
    for (const host of CI_HOSTS) {
      const result = await getAdapter(host).initCi({ site, packageManager: 'pnpm', previews: false })
      expect(result.files.some(f => f.path.includes('preview-')), `${host}`).toBe(false)
    }
  })

  test('the PR comment body uses real backticks, not markdown-escaped ones', async () => {
    // Regression: the generated body carried \` , which markdown renders
    // as a literal backtick instead of formatting the sha as code.
    const result = await getAdapter('netlify').initCi({ site, packageManager: 'pnpm', previews: true })
    const preview = result.files.find(f => f.path.includes('preview-'))
    const doc = loadYaml(preview.content)
    const step = doc.jobs.preview.steps.find(s => s.name === 'Comment the preview URL')
    expect(step.with.body).toContain('Built from `${{ github.event.pull_request.head.sha }}`')
    expect(step.with.body).not.toContain('\\`')
  })

  test('every ci-capable adapter records a deploy.yml target naming itself', async () => {
    for (const host of CI_HOSTS) {
      const result = await getAdapter(host).initCi({ site, packageManager: 'pnpm' })
      expect(result.targetConfig?.host, `${host} targetConfig`).toBe(host)
    }
  })
})

describe('github-pages foundation CI', () => {
  const foundations = [
    { name: 'marketing', path: 'foundations/marketing' },
    { name: 'docs', path: 'foundations/docs' },
  ]

  test('publishes each foundation at a versioned path using the CLI-resolved name', async () => {
    const result = await getAdapter('github-pages').initCi({
      target: 'foundation', foundations, packageManager: 'pnpm', nodeVersion: '20',
    })
    const workflow = result.files[0]
    expect(workflow.path).toBe('.github/workflows/publish-foundations.yml')
    // Names are baked in as <name>:<dir> pairs — not derived with
    // basename at CI time, because the name is part of a permanent URL.
    expect(workflow.content).toContain('"marketing:foundations/marketing"')
    expect(workflow.content).toContain('"docs:foundations/docs"')
    expect(workflow.content).toContain('foundations/$name/$version')
    expect(() => loadYaml(workflow.content)).not.toThrow()
  })

  test('layers onto gh-pages rather than replacing it (old versions must survive)', async () => {
    const result = await getAdapter('github-pages').initCi({
      target: 'foundation', foundations, packageManager: 'pnpm',
    })
    const yaml = result.files[0].content
    expect(yaml).toContain('cp -R _staging/foundations/. _gh-pages/foundations/')
    expect(yaml).toContain('touch _gh-pages/.nojekyll')
    expect(yaml).not.toContain('git push --force')
  })

  test('writes no deploy.yml target (a foundation is not a site)', async () => {
    const result = await getAdapter('github-pages').initCi({
      target: 'foundation', foundations, packageManager: 'pnpm',
    })
    expect(result.targetConfig).toBeNull()
  })

  test('refuses when there is no foundation to publish', async () => {
    await expect(
      getAdapter('github-pages').initCi({ target: 'foundation', foundations: [], packageManager: 'pnpm' })
    ).rejects.toThrow(/No foundation/)
  })
})

describe('github-pages public URL inference', () => {
  test('project repo is served under /<repo>/', () => {
    expect(pagesUrlFromRemote('git@github.com:Acme/my-site.git')).toBe('https://acme.github.io/my-site/')
    expect(pagesUrlFromRemote('https://github.com/Acme/my-site')).toBe('https://acme.github.io/my-site/')
  })

  test('profile repo (<user>.github.io) is served at the domain root', () => {
    expect(pagesUrlFromRemote('https://github.com/Acme/Acme.github.io.git')).toBe('https://acme.github.io/')
  })

  test('a non-GitHub remote yields null rather than a guess', () => {
    expect(pagesUrlFromRemote('git@gitlab.com:acme/site.git')).toBeNull()
    expect(pagesUrlFromRemote('../origin.git')).toBeNull()
  })
})
