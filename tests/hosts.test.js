/**
 * Tests for the host adapter registry and the V1 built-in adapters.
 * See kb/framework/plans/static-host-deploy-adapters.md.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { getAdapter, listAdapters } from '../src/hosts/index.js'
import { emitRedirectsFile } from '../src/hosts/cloudflare-pages.js'

describe('host registry', () => {
  test('lists built-in adapter names sorted', () => {
    const names = listAdapters()
    expect(names).toEqual(['cloudflare-pages', 'generic-static', 'github-pages', 's3-cloudfront'])
  })

  test('getAdapter returns the named adapter', () => {
    expect(getAdapter('cloudflare-pages').name).toBe('cloudflare-pages')
    expect(getAdapter('github-pages').name).toBe('github-pages')
    expect(getAdapter('generic-static').name).toBe('generic-static')
    expect(getAdapter('s3-cloudfront').name).toBe('s3-cloudfront')
  })

  test('getAdapter throws on unknown name with the list of known names', () => {
    expect(() => getAdapter('nope')).toThrow(/Unknown deploy host 'nope'/)
    expect(() => getAdapter('nope')).toThrow(/cloudflare-pages, generic-static, github-pages, s3-cloudfront/)
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

  test('has no deploy function (users push to gh-pages branch)', () => {
    expect(getAdapter('github-pages').deploy).toBeUndefined()
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
