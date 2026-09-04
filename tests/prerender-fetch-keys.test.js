/**
 * What the build bakes into `fetchedData` must be findable by the runtime.
 *
 * The SPA hydrates its DataStore under `deriveCacheKey(resolvedConfig)` of the
 * config IT resolves through `@uniweb/core/fetch-config`. The build used to bake
 * a hand-localized copy of the authored config; any field the shared rule adds
 * (`depth`, a `detail` pattern, the localized path) made the two keys drift and a
 * prerendered site refetch on boot with nothing failing. These pin that the build
 * resolves through the same rule and files the depth the record index needs.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveFetchConfigs, deriveCacheKey } from '@uniweb/core'
import { executeAllFetches } from '../src/prerender.js'

function site(files) {
  const root = mkdtempSync(join(tmpdir(), 'prerender-keys-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

const noop = () => {}

describe('executeAllFetches resolves each declaration the way the runtime does', () => {
  it('a deferred query is baked at BRIEF depth under the key the SPA will look up', async () => {
    const root = site({ 'public/data/articles.json': JSON.stringify([{ slug: 'a', title: 'A' }]) })
    const content = {
      config: { queries: { articles: { name: 'articles', deferred: ['body'] } } },
      pages: [{ route: '/blog', fetch: { query: 'articles', path: '/data/articles.json', as: 'articles', prerender: true } }],
    }
    const { fetchedData } = await executeAllFetches(content, root, noop, { locale: 'en', defaultLocale: 'en' })
    const entry = fetchedData.find((e) => e.config.as === 'articles')
    expect(entry.meta).toEqual({ depth: 'brief' })
    // the runtime's key for the same declaration
    const runtimeCfg = resolveFetchConfigs([content.pages[0].fetch], { queries: content.config.queries, locale: 'en', defaultLocale: 'en' }).get('articles')
    expect(deriveCacheKey(entry.config)).toBe(deriveCacheKey(runtimeCfg))
    rmSync(root, { recursive: true, force: true })
  })

  it('a non-default locale reads the localized file and bakes the localized key', async () => {
    const root = site({ 'public/data/articles.json': JSON.stringify([{ slug: 'a', title: 'A' }]) })
    const dist = join(root, 'dist')
    mkdirSync(join(dist, 'fr', 'data'), { recursive: true })
    writeFileSync(join(dist, 'fr', 'data', 'articles.json'), JSON.stringify([{ slug: 'a', title: 'Un' }]))
    const content = {
      config: {},
      pages: [{ route: '/blog', fetch: { query: 'articles', path: '/data/articles.json', as: 'articles', prerender: true } }],
    }
    const { fetchedData } = await executeAllFetches(content, root, noop, { locale: 'fr', defaultLocale: 'en', distDir: dist })
    const entry = fetchedData.find((e) => e.config.as === 'articles')
    expect(entry.data).toEqual([{ slug: 'a', title: 'Un' }])
    expect(entry.config.path).toBe('/fr/data/articles.json')
    expect(entry.meta).toEqual({ depth: 'full' })
    const runtimeCfg = resolveFetchConfigs([content.pages[0].fetch], { locale: 'fr', defaultLocale: 'en' }).get('articles')
    expect(deriveCacheKey(entry.config)).toBe(deriveCacheKey(runtimeCfg))
    rmSync(root, { recursive: true, force: true })
  })
})
