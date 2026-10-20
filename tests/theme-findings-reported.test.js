/**
 * What `theme.yml` gets wrong is printed by the build.
 *
 * The theme check's findings — a colour that is not one, a key nothing reads —
 * came back from `buildTheme` as `errors`, and the build printed only its
 * `warnings`, so until 2026-10-19 they reached no one: a misspelled `code:` key
 * did nothing on the page and nothing in the terminal. Neither stops the build.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('collectSiteContent — theme findings', () => {
  let siteDir
  let warn

  async function makeSite(themeYml) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-site-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), 'name: Test\n')
    await writeFile(join(siteDir, 'theme.yml'), themeYml)
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
    return siteDir
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    warn.mockRestore()
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  const printed = () => warn.mock.calls.map((args) => String(args[0])).filter((line) => line.startsWith('[theme] '))

  it('a misspelled code colour is named, and the build goes on', async () => {
    const content = await collectSiteContent(await makeSite("code:\n  keywrod: '#f00'\n"))
    expect(printed()).toContainEqual(expect.stringMatching(/^\[theme\] code\.keywrod is not a code colour/))
    expect(content.pages.length).toBeGreaterThan(0)
  })

  it('CONTROL — a code theme kit reads prints nothing about code', async () => {
    await collectSiteContent(await makeSite("code:\n  light: github-light\n  dark: github-dark\n"))
    expect(printed().filter((line) => /\bcode\b/.test(line))).toEqual([])
  })
})
