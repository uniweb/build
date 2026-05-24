/**
 * Tests for the CI host context detector.
 */

import { detectCiContext } from '../src/hosts/detect-ci-context.js'

describe('detectCiContext', () => {
  test('returns null when no CI host or runner is detected', () => {
    expect(detectCiContext({})).toBeNull()
    expect(detectCiContext({ HOME: '/home/dev' })).toBeNull()
  })

  describe('Vercel', () => {
    test('detects Vercel and reads its env vars', () => {
      const ctx = detectCiContext({
        VERCEL: '1',
        VERCEL_ENV: 'production',
        VERCEL_GIT_COMMIT_SHA: 'abc123',
        VERCEL_GIT_COMMIT_REF: 'main',
        VERCEL_URL: 'mysite.vercel.app',
        VERCEL_DEPLOYMENT_ID: 'dpl_xyz',
      })
      expect(ctx).toEqual({
        host: 'vercel',
        runner: 'vercel',
        branch: 'main',
        sha: 'abc123',
        isProduction: true,
        publicUrl: 'https://mysite.vercel.app',
        deploymentId: 'dpl_xyz',
      })
    })

    test('isProduction is false on a preview build', () => {
      const ctx = detectCiContext({ VERCEL: '1', VERCEL_ENV: 'preview' })
      expect(ctx.isProduction).toBe(false)
    })

    test('isProduction is null when VERCEL_ENV is unset', () => {
      const ctx = detectCiContext({ VERCEL: '1' })
      expect(ctx.isProduction).toBeNull()
    })
  })

  describe('Cloudflare Pages', () => {
    test('detects CF Pages and reads its env vars', () => {
      const ctx = detectCiContext({
        CF_PAGES: '1',
        CF_PAGES_BRANCH: 'main',
        CF_PAGES_COMMIT_SHA: 'abc123',
        CF_PAGES_URL: 'https://mysite.pages.dev',
      })
      expect(ctx.host).toBe('cloudflare-pages')
      expect(ctx.runner).toBe('cloudflare-pages')
      expect(ctx.branch).toBe('main')
      expect(ctx.sha).toBe('abc123')
      expect(ctx.publicUrl).toBe('https://mysite.pages.dev')
    })

    test('isProduction is null (CF Pages does not expose a clean signal)', () => {
      const ctx = detectCiContext({
        CF_PAGES: '1',
        CF_PAGES_BRANCH: 'main',
      })
      expect(ctx.isProduction).toBeNull()
    })
  })

  describe('Netlify', () => {
    test('detects Netlify and reads its env vars', () => {
      const ctx = detectCiContext({
        NETLIFY: 'true',
        CONTEXT: 'production',
        BRANCH: 'main',
        COMMIT_REF: 'abc123',
        DEPLOY_PRIME_URL: 'https://main--mysite.netlify.app',
        URL: 'https://mysite.netlify.app',
        DEPLOY_ID: 'deploy_xyz',
      })
      expect(ctx).toEqual({
        host: 'netlify',
        runner: 'netlify',
        branch: 'main',
        sha: 'abc123',
        isProduction: true,
        publicUrl: 'https://main--mysite.netlify.app',
        deploymentId: 'deploy_xyz',
      })
    })

    test('isProduction false on a deploy-preview', () => {
      const ctx = detectCiContext({ NETLIFY: 'true', CONTEXT: 'deploy-preview' })
      expect(ctx.isProduction).toBe(false)
    })

    test('publicUrl falls back to URL when DEPLOY_PRIME_URL is unset', () => {
      const ctx = detectCiContext({
        NETLIFY: 'true',
        URL: 'https://mysite.netlify.app',
      })
      expect(ctx.publicUrl).toBe('https://mysite.netlify.app')
    })
  })

  describe('GitHub Actions (runner-only)', () => {
    test('detects GHA but does NOT default a host (it is a runner, not a target)', () => {
      const ctx = detectCiContext({
        GITHUB_ACTIONS: 'true',
        GITHUB_REF_NAME: 'main',
        GITHUB_SHA: 'abc123',
        GITHUB_RUN_ID: '42',
      })
      expect(ctx.host).toBeNull()
      expect(ctx.runner).toBe('github-actions')
      expect(ctx.branch).toBe('main')
      expect(ctx.sha).toBe('abc123')
      expect(ctx.deploymentId).toBe('42')
      expect(ctx.isProduction).toBeNull()
    })
  })

  describe('precedence', () => {
    test('Vercel signal wins over GHA when both are set', () => {
      // GHA can host a Vercel deploy via Action; the host signal takes
      // precedence over the runner signal so --host defaults to vercel.
      const ctx = detectCiContext({
        GITHUB_ACTIONS: 'true',
        VERCEL: '1',
      })
      expect(ctx.host).toBe('vercel')
      expect(ctx.runner).toBe('vercel')
    })
  })
})
