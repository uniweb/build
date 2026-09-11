/**
 * A level's data declaration — `fetch:`, or its shorthand `query:` — one concept,
 * two authored spellings, three lanes (the payload, the sync push, the pull).
 *
 * `query:` is the SHORTHAND for `fetch:`: `query: articles` means
 * `fetch: { query: articles }`, and a list means one declaration per entry. It
 * takes query names only; anything richer is `fetch:`. The shorthand was `data:`
 * until 2026-09-11 [Diego], and `data:` is now refused at every level — in
 * frontmatter an unreserved key becomes a section param, so ignoring it would
 * render an empty section and say nothing.
 *
 * The site level had three separate defects, fixed 2026-09-09, and each still has
 * a test here:
 *
 *   1. the PAYLOAD lane read `siteConfig.fetch` alone, so the site's shorthand
 *      reached a backend on the sync lane and was silently dropped from a static
 *      build — the works-on-one-lane shape;
 *   2. the SYNC producer emitted the shorthand undesugared, so `settings.fetch`
 *      carried a bare string or a full config depending on which key was typed;
 *   3. the PROJECTOR wrote it back verbatim as the shorthand, so an author who
 *      typed `fetch:` pushed, pulled, and got the shorthand back — the value
 *      survived and the authored key did not, which the round-trip law forbids
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

const FOUNDATION = 'foundation: "@acme/x@1.0.0"\n'
const siteYmlOf = (dir) => yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))

/** Push `src`, then pull what it carried into `dest` (a working copy, or a fresh one). */
async function cycle(src, dest) {
  const { info, settings } = await siteProjectToDocument(src)
  siteInfoToConfig({ document: { info, settings }, siteRoot: dest })
  return siteYmlOf(dest)
}

afterEach(async () => {
  while (DIRS.length) await rm(DIRS.pop(), { recursive: true, force: true })
})

describe('1 · the payload lane honours `query:` as well as `fetch:`', () => {
  it('desugars a site-level `query:` into the payload fetch config', async () => {
    const dir = await makeSite('name: T\nquery: articles\n')
    const content = await collectSiteContent(dir)
    // The shorthand resolves to the same address the long form would produce.
    expect(content.config.fetch).toBeTruthy()
    expect(content.config.fetch.as).toBe('articles')
    // …and ships only desugared: a raw `config.query` would sit beside
    // `config.queries`, the declarations, and read as one.
    expect(content.config).not.toHaveProperty('query')
  })

  it('a list means one declaration per entry', async () => {
    const dir = await makeSite('name: T\nquery: [articles, team]\n')
    const content = await collectSiteContent(dir)
    expect(Array.isArray(content.config.fetch)).toBe(true)
    expect(content.config.fetch.map((f) => f.as)).toEqual(['articles', 'team'])
  })

  it('`query:` beside `fetch:` is refused — it was silent, and the shorthand was dropped', async () => {
    const dir = await makeSite('name: T\nquery: articles\nfetch:\n  path: /data/team.json\n')
    await expect(collectSiteContent(dir)).rejects.toThrow(/site\.yml: declare `query:` or `fetch:`, not both/)
  })
})

describe('2 · the sync producer emits the DESUGARED form', () => {
  it('`query: articles` reaches the wire as a query declaration, not a bare string', async () => {
    const dir = await makeSite(`name: T\n${FOUNDATION}query: articles\n`)
    const { settings } = await siteProjectToDocument(dir)
    expect(settings.fetch).toEqual({ query: 'articles' })
  })

  it('both authored spellings produce the same wire shape', async () => {
    const viaShorthand = await siteProjectToDocument(await makeSite(`name: T\n${FOUNDATION}query: articles\n`))
    const viaLongForm = await siteProjectToDocument(await makeSite(`name: T\n${FOUNDATION}fetch:\n  query: articles\n`))
    expect(viaShorthand.settings.fetch).toEqual(viaLongForm.settings.fetch)
  })

  it('refuses what the build refuses — `query:` beside `fetch:`, and a retired `data:`', async () => {
    await expect(siteProjectToDocument(await makeSite(`name: T\n${FOUNDATION}query: a\nfetch: { query: b }\n`)))
      .rejects.toThrow(/not both/)
    await expect(siteProjectToDocument(await makeSite(`name: T\n${FOUNDATION}data: articles\n`)))
      .rejects.toThrow(/Write `query: articles`/)
  })
})

describe('3 · the round trip keeps the authored key', () => {
  it('a working copy that typed `fetch:` gets `fetch:` back', async () => {
    const dir = await makeSite(`name: T\n${FOUNDATION}fetch:\n  query: articles\n`)
    const back = await cycle(dir, dir)
    expect(back.fetch).toEqual({ query: 'articles' })
    expect(back).not.toHaveProperty('query')
  })

  it('a working copy that typed `query:` gets `query:` back — never `fetch:` beside it', async () => {
    const dir = await makeSite(`name: T\n${FOUNDATION}query: [articles, team]\n`)
    const back = await cycle(dir, dir)
    expect(back.query).toEqual(['articles', 'team'])
    expect(back).not.toHaveProperty('fetch')
  })

  it('a fresh copy gets `query:` for names alone, and `fetch:` for anything richer', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'uniweb-sitefetch-fresh-'))
    DIRS.push(plain)
    expect(await cycle(await makeSite(`name: T\n${FOUNDATION}fetch:\n  query: articles\n`), plain)).toMatchObject({ query: 'articles' })

    const rich = await mkdtemp(join(tmpdir(), 'uniweb-sitefetch-fresh-'))
    DIRS.push(rich)
    const back = await cycle(await makeSite(`name: T\n${FOUNDATION}fetch:\n  query: articles\n  limit: 3\n`), rich)
    expect(back.fetch).toEqual({ query: 'articles', limit: 3 })
    expect(back).not.toHaveProperty('query')
  })

  it('a declaration that outgrew `query:` comes back as `fetch:`, and the `query:` line goes', async () => {
    const remote = await makeSite(`name: T\n${FOUNDATION}fetch:\n  query: articles\n  limit: 3\n`)
    const local = await makeSite(`name: T\n${FOUNDATION}query: articles\n`)
    const back = await cycle(remote, local)
    expect(back.fetch).toEqual({ query: 'articles', limit: 3 })
    expect(back).not.toHaveProperty('query')
  })

  it('a pulled `fetch:` replaces the local one whole — a stale key does not survive', async () => {
    // ⛔ `site.yml` object values were shallow-merged, so a `limit` the remote no
    // longer has outlived every pull.
    const remote = await makeSite(`name: T\n${FOUNDATION}fetch:\n  query: articles\n  sort: date desc\n`)
    const local = await makeSite(`name: T\n${FOUNDATION}fetch:\n  query: articles\n  limit: 3\n`)
    expect((await cycle(remote, local)).fetch).toEqual({ query: 'articles', sort: 'date desc' })
  })

  it('a retired `data:` line in the working copy is replaced, so the pulled file builds', async () => {
    const remote = await makeSite(`name: T\n${FOUNDATION}query: articles\n`)
    const local = await makeSite(`name: T\n${FOUNDATION}data: articles\n`)
    const back = await cycle(remote, local)
    expect(back).toMatchObject({ query: 'articles' })
    expect(back).not.toHaveProperty('data')
  })

  it('holds still from there: a second cycle moves nothing', async () => {
    const dir = await makeSite(`name: T\n${FOUNDATION}query: articles\n`)
    const first = await siteProjectToDocument(dir)
    await cycle(dir, dir)
    const second = await siteProjectToDocument(dir)
    expect(second.settings.fetch).toEqual(first.settings.fetch)
    expect(siteYmlOf(dir)).toMatchObject({ query: 'articles' })
  })
})
