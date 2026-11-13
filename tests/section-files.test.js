/**
 * One section, one file (`src/site/section-files.js`). A number orders a section and never names it,
 * so `1-lost.md` beside `lost.md` is the section `lost` twice: a merge left exactly that on 2026-11-12,
 * and the page showed the hero twice with nothing said. The build names both files and goes on, as a
 * site build does; a push refuses the page.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sectionFilesNamedTwice, describeSectionsNamedTwice } from '../src/site/section-files.js'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('sectionFilesNamedTwice', () => {
  it('⭐ finds a section held by a numbered and an unnumbered file', () => {
    expect(sectionFilesNamedTwice(['lost.md', 'page.yml', '1-lost.md', '2-found.md'])).toEqual([
      { name: 'lost', files: ['1-lost.md', 'lost.md'] },
    ])
  })

  it("keeps a child's @ apart, and leaves alone what is no section file", () => {
    expect(sectionFilesNamedTwice(['@card.md', '@1-card.md', 'card.md', 'README.md', '_draft.md', 'readme.md'])).toEqual([
      { name: '@card', files: ['@1-card.md', '@card.md'] },
    ])
  })

  it('CONTROL — distinct sections, a number alone, and a name with its own digits are each one section', () => {
    expect(sectionFilesNamedTwice(['1-hero.md', '2-hero-image.md', '404.md', '3d-printing.md', '1-3d-printing.md'])).toEqual([
      { name: '3d-printing', files: ['1-3d-printing.md', '3d-printing.md'] },
    ])
    expect(sectionFilesNamedTwice(['1-hero.md', '2-features.md', '404.md'])).toEqual([])
  })

  it('says which page holds which section twice', () => {
    expect(describeSectionsNamedTwice('pages/404', [{ name: 'lost', files: ['1-lost.md', 'lost.md'] }])).toBe(
      'pages/404 holds the section "lost" in 2 files: 1-lost.md, lost.md'
    )
  })
})

describe('the build', () => {
  let ROOT
  const w = (rel, body) => {
    mkdirSync(join(ROOT, rel, '..'), { recursive: true })
    writeFileSync(join(ROOT, rel), body)
  }
  beforeEach(() => {
    ROOT = mkdtempSync(join(tmpdir(), 'section-files-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    w('site/site.yml', 'name: T\nfoundation: fnd\nindex: home\n')
    w('site/pages/home/1-hero.md', '---\ntype: Hero\n---\n\n# Home\n')
    w('site/pages/404/page.yml', 'title: Page not found\n')
    w('site/pages/404/1-lost.md', '---\ntype: Hero\n---\n\n# Wrong floor\n')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('⭐ names both files of a section held twice, says a push refuses it, and goes on', async () => {
    w('site/pages/404/lost.md', '---\ntype: Hero\n---\n\n# Wrong floor\n')
    const content = await collectSiteContent(join(ROOT, 'site'))
    const said = console.warn.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(said).toMatch(/pages\/404 holds the section "lost" in 2 files: 1-lost\.md, lost\.md\. A number orders a section[\s\S]*a push refuses this page/)
    expect(content.notFound.sections.map((s) => s.stableId)).toEqual(['lost', 'lost'])
  })

  it('CONTROL — with one file for it, the page has the section once, and nothing is said', async () => {
    const content = await collectSiteContent(join(ROOT, 'site'))
    expect(console.warn.mock.calls.flat().join(' ')).not.toMatch(/holds the section/)
    // The not-found page is collected on its own, and is checked like any page.
    expect(content.notFound.sections.map((s) => s.stableId)).toEqual(['lost'])
  })
})
