/**
 * A `where` outside the language stops the build, where the author wrote it.
 *
 * Every lane answers such a where with no records (`@uniweb/core`'s
 * `whereOutsideLanguage`) — on a page that reads as "nothing matched". So the
 * producers refuse it: the fetch parser, the query processor, and the sync producer
 * for a page's and the site's fetch. ⛔ `like` and `nin` worked until 2026-09-13.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { parseFetchConfig } from '../src/site/data-fetcher.js'
import { processQueries } from '../src/site/query-processor.js'
import { siteProjectToDocument } from '../src/uwx/site.js'

const dirs = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function site(files) {
  const root = mkdtempSync(join(tmpdir(), 'uniweb-where-language-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries({ 'site.yml': 'name: probe\nfoundation: "@acme/foundation@1.0.0"\n', ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

describe('a where outside the language stops the build', () => {
  it('on a fetch — a retired operator, named with its replacement', () => {
    expect(() => parseFetchConfig({ query: 'members', where: { status: { nin: ['draft'] } } })).toThrow(
      /fetch: `nin` is spelled `not_in`/
    )
    expect(() => parseFetchConfig({ path: '/data/a.json', where: { title: { like: 'The*' } } })).toThrow(/`like` is retired/)
  })

  it('on a named query', async () => {
    const root = site({})
    await expect(processQueries(root, { articles: { schema: '@/article', where: { and: [] } } })).rejects.toThrow(
      /queries\.articles: `and` takes a non-empty list/
    )
  })

  it('on a page\'s fetch, when it syncs', async () => {
    const root = site({
      'pages/home/page.yml': 'fetch:\n  query: members\n  where: { role: { equals: lead } }\n',
      'pages/home/1-hero.md': '---\ntype: Hero\n---\n# Home\n',
    })
    await expect(siteProjectToDocument(root)).rejects.toThrow(/`equals` \(on `role`\) is not an operator/)
  })

  it('lets the whole language through — route variables, text operators, not_in and composition', () => {
    const where = {
      tag: ':dir',
      title: { starts_with: 'the' },
      status: { not_in: ['draft'] },
      or: [{ featured: true }, { 'education.degree': { contains: 'PhD' } }],
      not: { archived: { exists: true } },
    }
    expect(parseFetchConfig({ query: 'articles', where }).where).toEqual(where)
  })
})
