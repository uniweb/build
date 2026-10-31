/**
 * A page folder's files in the order the page has them (`pageSectionFiles`), for a tool that shows a
 * page (`uniweb inspect`). The page's own walk, so these cases hold against what a build makes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pageSectionFiles } from '../src/content/index.js'

describe('pageSectionFiles', () => {
  let root
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function page(files, yml) {
    root = await mkdtemp(join(tmpdir(), 'uniweb-page-files-'))
    const dir = join(root, 'pages', 'home')
    await mkdir(dir, { recursive: true })
    await writeFile(join(root, 'site.yml'), 'name: S\n')
    for (const file of files) await writeFile(join(dir, file), `---\ntype: T\n---\n# ${file}\n`)
    if (yml) await writeFile(join(dir, 'page.yml'), yml)
    return pageSectionFiles(dir, root)
  }

  it('with no list, by the numbers in their names', async () => {
    expect(await page(['10-a.md', '2-b.md', '1-c.md'])).toEqual(['1-c.md', '2-b.md', '10-a.md'])
  })

  it('in the order `sections:` names them, whatever their names', async () => {
    expect(await page(['alpha.md', 'beta.md', 'gamma.md'], 'sections: [gamma, alpha, beta]\n')).toEqual([
      'gamma.md',
      'alpha.md',
      'beta.md',
    ])
  })

  it('finds a named file through its number', async () => {
    expect(await page(['1-alpha.md', '2-beta.md'], 'sections: [beta, alpha]\n')).toEqual(['2-beta.md', '1-alpha.md'])
  })

  it('leaves out what a list does not name', async () => {
    expect(await page(['alpha.md', 'beta.md', 'gamma.md'], 'sections: [gamma, alpha]\n')).toEqual(['gamma.md', 'alpha.md'])
  })

  it('places the rest where `...` stands', async () => {
    expect(await page(['alpha.md', 'beta.md', 'gamma.md'], 'sections: [gamma, ...]\n')).toEqual([
      'gamma.md',
      'alpha.md',
      'beta.md',
    ])
  })

  it('puts a child after its parent, by `nest:`', async () => {
    const files = await page(['1-hero.md', '2-grid.md', '3-end.md', '@card.md'], 'nest:\n  grid: [card]\n')
    expect(files).toEqual(['1-hero.md', '2-grid.md', '@card.md', '3-end.md'])
  })

  it('puts a child after its parent, in a list', async () => {
    const files = await page(['end.md', 'grid.md', 'a.md', 'b.md'], 'sections:\n  - grid: [b, a]\n  - end\n')
    expect(files).toEqual(['grid.md', 'b.md', 'a.md', 'end.md'])
  })

  it('takes neither a draft nor a README', async () => {
    expect(await page(['_draft.md', 'README.md', 'a.md'])).toEqual(['a.md'])
  })

  it('has nothing for a page that redirects', async () => {
    expect(await page(['a.md'], 'redirect: /elsewhere\n')).toEqual([])
  })
})
