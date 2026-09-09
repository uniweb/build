/**
 * Site-level `fetch:` / `data:` — one concept, two authored spellings, three lanes.
 *
 * `data:` is the authoring SHORTHAND for `fetch:`: `data: articles` means
 * `fetch: { query: articles }`, and a list means one declaration per entry. The
 * page level has always desugared it (`fetchFromDataShorthand`). The site level
 * had three separate defects, fixed 2026-09-09, and each has a test here:
 *
 *   1. the PAYLOAD lane read `siteConfig.fetch` alone, so `site.yml::data:`
 *      reached a backend on the sync lane and was silently dropped from a static
 *      build — the works-on-one-lane shape;
 *   2. the SYNC producer emitted the shorthand undesugared, so `settings.fetch`
 *      carried a bare string or a full config depending on which key was typed;
 *   3. the PROJECTOR wrote it back verbatim as `site.yml::data`, so an author who
 *      typed `fetch:` pushed, pulled, and got a `data:` block — the value survived
 *      and the authored key did not, which the round-trip law forbids
 *      (`kb/framework/build/uwx-format.md`).
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import yaml from 'js-yaml'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument, siteInfoToConfig } from '../src/uwx/index.js'

const DIRS = []

async function makeSite(siteYml) {
  const root = await mkdtemp(join(tmpdir(), 'uniweb-sitefetch-'))
  DIRS.push(root)
  await mkdir(join(root, 'pages', 'home'), { recursive: true })
  await writeFile(join(root, 'site.yml'), siteYml)
  await writeFile(join(root, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Home\n')
  return root
}

afterEach(async () => {
  while (DIRS.length) await rm(DIRS.pop(), { recursive: true, force: true })
})

describe('1 · the payload lane honours `data:` as well as `fetch:`', () => {
  it('desugars a site-level `data:` into the payload fetch config', async () => {
    const dir = await makeSite('name: T\ndata: articles\n')
    const content = await collectSiteContent(dir)
    // The shorthand resolves to the same address the long form would produce.
    expect(content.config.fetch).toBeTruthy()
    expect(content.config.fetch.as).toBe('articles')
  })

  it('a list means one declaration per entry', async () => {
    const dir = await makeSite('name: T\ndata: [articles, team]\n')
    const content = await collectSiteContent(dir)
    expect(Array.isArray(content.config.fetch)).toBe(true)
    expect(content.config.fetch.map((f) => f.as)).toEqual(['articles', 'team'])
  })

  it('an explicit `fetch:` still wins over the shorthand', async () => {
    const dir = await makeSite('name: T\ndata: articles\nfetch:\n  path: /data/team.json\n')
    const content = await collectSiteContent(dir)
    expect(content.config.fetch.path).toBe('/data/team.json')
  })
})

describe('2 · the sync producer emits the DESUGARED form', () => {
  it('`data: articles` reaches the wire as a query declaration, not a bare string', async () => {
    const dir = await makeSite('name: T\nfoundation: "@acme/x@1.0.0"\ndata: articles\n')
    const { info, settings } = await siteProjectToDocument(dir)
    expect(settings.fetch).toEqual({ query: 'articles' })
  })

  it('both authored spellings produce the same wire shape', async () => {
    const viaShorthand = await siteProjectToDocument(
      await makeSite('name: T\nfoundation: "@acme/x@1.0.0"\ndata: articles\n')
    )
    const viaLongForm = await siteProjectToDocument(
      await makeSite('name: T\nfoundation: "@acme/x@1.0.0"\nfetch:\n  query: articles\n')
    )
    expect(viaShorthand.settings.fetch).toEqual(viaLongForm.settings.fetch)
  })
})

describe('3 · the round trip preserves the authored key', () => {
  it('projects back as `fetch:`, never `data:`', async () => {
    const dir = await makeSite('name: T\nfoundation: "@acme/x@1.0.0"\nfetch:\n  query: articles\n')
    const { info, settings } = await siteProjectToDocument(dir)

    const target = await mkdtemp(join(tmpdir(), 'uniweb-sitefetch-rt-'))
    DIRS.push(target)
    siteInfoToConfig({ document: { info, settings }, siteRoot: target })

    const back = yaml.load(readFileSync(join(target, 'site.yml'), 'utf8'))
    expect(back.fetch).toBeTruthy()
    expect(back.fetch.query).toBe('articles')
    expect(back).not.toHaveProperty('data')
  })

  it('the shorthand normalizes to the long form and then holds still', async () => {
    // `data: articles` is sugar, so a round trip canonicalizes it to `fetch:` —
    // the same normalization the page lane has always done. What matters is that
    // it is STABLE from there: a second cycle must not move it again.
    const dir = await makeSite('name: T\nfoundation: "@acme/x@1.0.0"\ndata: articles\n')
    const first = await siteProjectToDocument(dir)

    const target = await mkdtemp(join(tmpdir(), 'uniweb-sitefetch-rt2-'))
    DIRS.push(target)
    await mkdir(join(target, 'pages'), { recursive: true })
    siteInfoToConfig({ document: { info: first.info, settings: first.settings }, siteRoot: target })

    const afterOne = yaml.load(readFileSync(join(target, 'site.yml'), 'utf8'))
    expect(afterOne.fetch).toEqual({ query: 'articles' })

    // Cycle two, from the projected file.
    const second = await siteProjectToDocument(target)
    expect(second.settings.fetch).toEqual(first.settings.fetch)
  })

  it('tolerates a value stored before the producer desugared', async () => {
    // A site pushed before 2026-09-09 holds the bare shorthand. The projector
    // must normalize rather than hand a string to `authorableFetch`.
    const target = await mkdtemp(join(tmpdir(), 'uniweb-sitefetch-legacy-'))
    DIRS.push(target)
    siteInfoToConfig({
      document: { info: { name: 'T', foundation: '@acme/x@1.0.0', data: 'articles' } },
      siteRoot: target,
    })
    const back = yaml.load(readFileSync(join(target, 'site.yml'), 'utf8'))
    expect(back.fetch).toEqual({ query: 'articles' })
  })
})
