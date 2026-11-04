/**
 * ⭐ THE ONE RULE FOR A NUMBER THAT ORDERS A NAME (`src/utils/numeric-prefix.js`): a number then a dash,
 * `1-hero`, or a name that is only a number, `404`; dots are sub-levels, `2.5-x` [Diego, 2026-11-04].
 * ⛔ Until then the dash was optional, so `3d-printing` was 3 and `d-printing` on every lane.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { parseNumericPrefix, compareByNumericPrefix } from '../src/utils/numeric-prefix.js'
import { collectSiteContent } from '../src/site/content-collector.js'
import { resolveSectionFile } from '../src/uwx/project-writer.js'

describe('parseNumericPrefix', () => {
  it.each([
    ['1-hero', '1', 'hero'],
    ['01-welcome', '01', 'welcome'],
    ['2.5-x', '2.5', 'x'],
    ['2024-annual-report', '2024', 'annual-report'],
    ['404', '404', '404'],
    ['1.5', '1.5', '1.5'],
  ])('%s is numbered: %s, then %s', (stem, prefix, name) => {
    expect(parseNumericPrefix(stem)).toEqual({ prefix, name })
  })

  it.each(['3d-printing', '100days', '1hero', '05b-books', 'hero', '1-'])('⭐ %s is a name, with no number', (stem) => {
    expect(parseNumericPrefix(stem)).toEqual({ prefix: null, name: stem })
  })

  it('orders numbered names by their number, 2 before 10, and names after them', () => {
    expect(['3d-printing', '10-c', '2-b', '2.5-x', 'a'].sort(compareByNumericPrefix)).toEqual(['2-b', '2.5-x', '10-c', '3d-printing', 'a'])
  })
})

describe('the rule, where the build reads a site', () => {
  let ROOT
  const w = (rel, body) => {
    const p = join(ROOT, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  beforeEach(() => {
    ROOT = mkdtempSync(join(tmpdir(), 'numeric-prefix-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('⭐ a page named with its own digits keeps them, in its route and its title; a slotted one drops its number', async () => {
    w('site.yml', 'name: S\nindex: guide\n')
    w('pages/guide/folder.yml', 'pages: [...]\n')
    w('pages/guide/1-intro.md', 'Words.\n')
    w('pages/guide/2.5-setup.md', 'Words.\n')
    w('pages/guide/3d-printing.md', 'Words.\n')
    w('pages/3d-models/page.yml', 'id: models\n')
    w('pages/3d-models/body.md', '# Models\n')
    const { pages } = await collectSiteContent(ROOT, {})
    const byRoute = Object.fromEntries(pages.map((p) => [p.route, p.title]))
    expect(byRoute).toMatchObject({ '/3d-models': 'Models', '/intro': 'Intro', '/setup': 'Setup', '/3d-printing': '3d Printing' })
  })

  it('a section file is found by its name with a slotted number dropped', () => {
    w('pages/home/2.5-setup.md', '# Setup\n')
    w('pages/home/3d-printing.md', '# 3D\n')
    expect(resolveSectionFile(join(ROOT, 'pages/home'), 'setup')).toBe(join(ROOT, 'pages/home/2.5-setup.md'))
    expect(resolveSectionFile(join(ROOT, 'pages/home'), '3d-printing')).toBe(join(ROOT, 'pages/home/3d-printing.md'))
    expect(resolveSectionFile(join(ROOT, 'pages/home'), 'd-printing')).toBe(null)
  })
})
