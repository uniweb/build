/**
 * Tests for the s3-cloudfront host adapter.
 *
 * The deploy hook subprocesses the AWS CLI so it isn't unit-tested here;
 * the parts that are pure (config validation, error translation, manifest
 * shape, postBuild file emission) get full coverage. End-to-end deploy
 * verification happens against a real bucket during Phase 4 (uniweb-app
 * migration).
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import s3Cloudfront, {
  FUNCTION_SOURCE,
  DEFAULT_CACHE_RULES,
  DEFAULT_INVALIDATION_PATHS,
  buildManifest,
  augmentManifest,
  detectFoundationMode,
  validateDeployConfig,
  translateAwsError,
  DeployError,
} from '../src/hosts/s3-cloudfront.js'

describe('s3-cloudfront adapter shape', () => {
  test('exports the expected adapter interface', () => {
    expect(s3Cloudfront.name).toBe('s3-cloudfront')
    expect(typeof s3Cloudfront.postBuild).toBe('function')
    expect(typeof s3Cloudfront.deploy).toBe('function')
  })

  test('FUNCTION_SOURCE rewrites directory-style URIs', () => {
    // Sanity-check the source we ship to users. Eval'd as a function
    // body to verify the rewrite logic.
    const handler = new Function(`${FUNCTION_SOURCE}\nreturn handler;`)()

    expect(handler({ request: { uri: '/about' } }).uri).toBe('/about/index.html')
    expect(handler({ request: { uri: '/about/' } }).uri).toBe('/about/index.html')
    expect(handler({ request: { uri: '/fr/about' } }).uri).toBe('/fr/about/index.html')

    // Files (have an extension in the last segment) pass through.
    expect(handler({ request: { uri: '/assets/logo-abc.svg' } }).uri).toBe('/assets/logo-abc.svg')
    expect(handler({ request: { uri: '/about/index.html' } }).uri).toBe('/about/index.html')
    expect(handler({ request: { uri: '/sitemap.xml' } }).uri).toBe('/sitemap.xml')
  })
})

describe('s3-cloudfront postBuild', () => {
  let distDir

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), 'uniweb-s3cf-'))
  })

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true })
  })

  test('drops cloudfront-function.js with the rewrite source', async () => {
    await s3Cloudfront.postBuild({ distDir, onProgress: () => {} })
    const fnPath = join(distDir, 'cloudfront-function.js')
    expect(existsSync(fnPath)).toBe(true)
    const body = await readFile(fnPath, 'utf8')
    expect(body).toBe(FUNCTION_SOURCE)
    expect(body).toContain('function handler(event)')
  })

  test('drops a deploy manifest with config fields null at build time', async () => {
    // postBuild has no access to deploy.yml — config-shaped fields land
    // null. The deploy hook augments the manifest before upload.
    await s3Cloudfront.postBuild({ distDir, onProgress: () => {} })

    const manifestPath = join(distDir, '.uniweb-deploy-manifest.json')
    expect(existsSync(manifestPath)).toBe(true)

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest.host).toBe('s3-cloudfront')
    expect(manifest.bucket).toBeNull()
    expect(manifest.distributionId).toBeNull()
    expect(manifest.region).toBeNull()
    expect(manifest.cacheRules).toBeNull()
    expect(manifest.invalidationPaths).toBeNull()
    expect(manifest.cloudfrontFunctionFile).toBe('cloudfront-function.js')
    expect(typeof manifest.generatedAt).toBe('string')
  })

  test('manifest records standalone foundationMode for a workspace-local foundation', () => {
    const siteContent = { config: { foundation: 'file:../foundation' } }
    const manifest = buildManifest(siteContent)
    expect(manifest.foundationMode).toEqual({
      shape: 'standalone',
      foundation: 'file:../foundation',
      url: null,
    })
  })

  test('manifest records linked foundationMode for a registry ref', () => {
    const siteContent = { config: { foundation: '@uniweb/app@0.1.0' } }
    const manifest = buildManifest(siteContent)
    expect(manifest.foundationMode).toEqual({
      shape: 'linked',
      foundation: '@uniweb/app@0.1.0',
      url: null,
    })
  })

  test('manifest records linked foundationMode with url for an https foundation', () => {
    const siteContent = { config: { foundation: 'https://cdn.example/foundation.js' } }
    const manifest = buildManifest(siteContent)
    expect(manifest.foundationMode).toEqual({
      shape: 'linked',
      foundation: 'https://cdn.example/foundation.js',
      url: 'https://cdn.example/foundation.js',
    })
  })

  test('manifest carries ciContext when provided', () => {
    const ciContext = {
      host: 'vercel',
      runner: 'vercel',
      branch: 'main',
      sha: 'abc123',
      isProduction: true,
      publicUrl: 'https://mysite.vercel.app',
      deploymentId: 'dpl_xyz',
    }
    const manifest = buildManifest(null, ciContext)
    expect(manifest.ciContext).toEqual(ciContext)
  })

  test('manifest carries ciContext: null on local builds', () => {
    expect(buildManifest(null, null).ciContext).toBeNull()
    // Default arg also lands null.
    expect(buildManifest(null).ciContext).toBeNull()
  })

  test('postBuild persists ciContext to the manifest on disk', async () => {
    const ciContext = {
      host: 'vercel',
      runner: 'vercel',
      branch: 'main',
      sha: 'abc123',
      isProduction: true,
      publicUrl: 'https://mysite.vercel.app',
      deploymentId: null,
    }
    await s3Cloudfront.postBuild({ distDir, ciContext, onProgress: () => {} })
    const manifest = JSON.parse(
      await readFile(join(distDir, '.uniweb-deploy-manifest.json'), 'utf8')
    )
    expect(manifest.ciContext).toEqual(ciContext)
  })

  test('removes a stale _redirects file (defense in depth)', async () => {
    await writeFile(join(distDir, '_redirects'), '# left behind by netlify adapter')
    await s3Cloudfront.postBuild({ distDir, onProgress: () => {} })
    expect(existsSync(join(distDir, '_redirects'))).toBe(false)
  })

  test('does not fail when _redirects is absent', async () => {
    await expect(
      s3Cloudfront.postBuild({ distDir, onProgress: () => {} })
    ).resolves.toBeUndefined()
  })
})

describe('augmentManifest', () => {
  let distDir

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), 'uniweb-s3cf-aug-'))
  })

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true })
  })

  test('fills bucket/distId/region/cacheRules from deployConfig', async () => {
    await s3Cloudfront.postBuild({ distDir, onProgress: () => {} })
    await augmentManifest(distDir, {
      bucket: 'my-bucket',
      distributionId: 'E1ABC',
      region: 'us-east-1',
    })
    const manifest = JSON.parse(
      await readFile(join(distDir, '.uniweb-deploy-manifest.json'), 'utf8')
    )
    expect(manifest.bucket).toBe('my-bucket')
    expect(manifest.distributionId).toBe('E1ABC')
    expect(manifest.region).toBe('us-east-1')
    expect(manifest.cacheRules).toEqual(DEFAULT_CACHE_RULES)
    expect(manifest.invalidationPaths).toEqual(DEFAULT_INVALIDATION_PATHS)
    expect(typeof manifest.deployedAt).toBe('string')
  })

  test('preserves user-provided cacheRules and invalidationPaths', async () => {
    await s3Cloudfront.postBuild({ distDir, onProgress: () => {} })
    await augmentManifest(distDir, {
      bucket: 'b',
      distributionId: 'd',
      region: 'r',
      cacheRules: [{ match: 'images/**', cacheControl: 'public, max-age=999' }],
      invalidationPaths: ['/foo'],
    })
    const manifest = JSON.parse(
      await readFile(join(distDir, '.uniweb-deploy-manifest.json'), 'utf8')
    )
    expect(manifest.cacheRules).toEqual([{ match: 'images/**', cacheControl: 'public, max-age=999' }])
    expect(manifest.invalidationPaths).toEqual(['/foo'])
  })

  test('no-ops cleanly when manifest is missing', async () => {
    await expect(
      augmentManifest(distDir, { bucket: 'b', distributionId: 'd', region: 'r' })
    ).resolves.toBeUndefined()
    expect(existsSync(join(distDir, '.uniweb-deploy-manifest.json'))).toBe(false)
  })
})

describe('detectFoundationMode', () => {
  test('null/missing siteContent → standalone with null fields', () => {
    expect(detectFoundationMode(null)).toEqual({ shape: 'standalone', foundation: null, url: null })
    expect(detectFoundationMode({})).toEqual({ shape: 'standalone', foundation: null, url: null })
    expect(detectFoundationMode({ config: {} })).toEqual({ shape: 'standalone', foundation: null, url: null })
  })

  test('workspace-local file: ref → standalone', () => {
    expect(detectFoundationMode({ config: { foundation: 'file:../foundation' } }))
      .toEqual({ shape: 'standalone', foundation: 'file:../foundation', url: null })
  })

  test('plain workspace name → standalone', () => {
    expect(detectFoundationMode({ config: { foundation: 'foundation' } }))
      .toEqual({ shape: 'standalone', foundation: 'foundation', url: null })
  })

  test('registry ref @ns/name@ver → linked, no url', () => {
    expect(detectFoundationMode({ config: { foundation: '@uniweb/foo@1.2.3' } }))
      .toEqual({ shape: 'linked', foundation: '@uniweb/foo@1.2.3', url: null })
  })

  test('https URL → linked with url', () => {
    expect(detectFoundationMode({ config: { foundation: 'https://x.example/f.js' } }))
      .toEqual({ shape: 'linked', foundation: 'https://x.example/f.js', url: 'https://x.example/f.js' })
  })

  test('object with url → linked with url', () => {
    expect(detectFoundationMode({ config: { foundation: { ref: '@a/b@1', url: 'https://x.example/f.js' } } }))
      .toEqual({ shape: 'linked', foundation: '@a/b@1', url: 'https://x.example/f.js' })
  })
})

describe('validateDeployConfig', () => {
  test('passes when bucket, distributionId, and region are all set', () => {
    expect(() => validateDeployConfig({
      bucket: 'b', distributionId: 'd', region: 'r',
    })).not.toThrow()
  })

  test('cold-start (all fields missing) points at the one-time AWS setup walkthrough', () => {
    let err
    try { validateDeployConfig({}) } catch (e) { err = e }
    expect(err).toBeInstanceOf(DeployError)
    expect(err.message).toMatch(/one-time AWS setup/)
    expect(err.hint).toContain('aws-s3-cloudfront-setup')
    expect(err.hint).toContain('deploy.yml')
  })

  test('mentions only the actually-missing field', () => {
    let err
    try {
      validateDeployConfig({ bucket: 'b', region: 'r' })
    } catch (e) { err = e }
    expect(err.hint).toMatch(/Missing: distributionId/)
    expect(err.hint).not.toMatch(/Missing:.*bucket/)
  })
})

describe('translateAwsError', () => {
  test('credentials-not-found → friendly hint about credential chain', () => {
    const err = translateAwsError(255, 'Unable to locate credentials. You can configure credentials by running "aws configure".', ['s3', 'sync'])
    expect(err).toBeInstanceOf(DeployError)
    expect(err.message).toMatch(/AWS credentials not found/)
    expect(err.hint).toContain('Environment variables')
    expect(err.hint).toContain('~/.aws/credentials')
  })

  test('expired token → suggests refreshing the session', () => {
    const err = translateAwsError(255, 'An error occurred (ExpiredToken) when calling the GetObject operation', ['s3', 'sync'])
    expect(err.message).toMatch(/credentials expired/)
    expect(err.hint).toMatch(/aws sso login|rotate keys/)
  })

  test('access denied → lists the IAM permissions needed', () => {
    const err = translateAwsError(255, 'An error occurred (AccessDenied) when calling the PutObject operation', ['s3', 'sync'])
    expect(err.message).toMatch(/lacks required permissions/)
    expect(err.hint).toContain('s3:PutObject')
    expect(err.hint).toContain('cloudfront:CreateInvalidation')
  })

  test('NoSuchBucket → points at the deploy.yml target bucket', () => {
    const err = translateAwsError(255, 'NoSuchBucket: The specified bucket does not exist', ['s3', 'sync'])
    expect(err.hint).toMatch(/bucket.*region.*deploy\.yml/)
  })

  test('NoSuchDistribution → points at deploy.distributionId', () => {
    const err = translateAwsError(255, 'NoSuchDistribution', ['cloudfront', 'create-invalidation'])
    expect(err.hint).toMatch(/deploy\.distributionId/)
  })

  test('endpoint connection error → suggests checking region and network', () => {
    const err = translateAwsError(255, 'Could not connect to the endpoint URL', ['s3', 'sync'])
    expect(err.hint).toMatch(/network|region/i)
  })

  test('unknown error → surfaces the raw stderr in the hint', () => {
    const err = translateAwsError(1, 'Some weird error nobody has seen before', ['s3', 'sync'])
    expect(err.message).toMatch(/aws s3 sync failed \(exit 1\)/)
    expect(err.hint).toContain('Some weird error nobody has seen before')
  })

  test('exit code with no stderr still produces a useful message', () => {
    const err = translateAwsError(2, '', ['cloudfront', 'create-invalidation'])
    expect(err.message).toMatch(/aws cloudfront create-invalidation failed \(exit 2\)/)
    expect(err.hint).toMatch(/No error output captured/)
  })
})
