/**
 * ⭐ THE SHELL CARRIES THE SITE'S LOOK, by the runtime's own rule (`writePageAppearance`): the scheme
 * class on `<html>` where every first visit gets one look, and the pre-paint script where the
 * browser decides — a visitor's choice on a site with a switch, or the system's preference. A page
 * the browser renders itself (every page under `uniweb dev`, a build that doesn't prerender) paints
 * this shell before the bundle boots, and a prerendered page is rendered into it.
 *
 * ⛔ Until 2026-11-11 the shell carried no class, and every site with dark carried the script, so a
 * site set to dark depended on a script for its look.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentPlugin } from '../src/site/plugin.js'

const INDEX = '<!doctype html><html lang="en"><head></head><body></body></html>'

describe('the site plugin writes the site’s look into the shell', () => {
  let root
  let saved
  beforeEach(() => {
    saved = [console.log, console.warn]
    console.log = () => {}
    console.warn = () => {}
  })
  afterEach(async () => {
    ;[console.log, console.warn] = saved
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function shellFor(themeYml) {
    root = await mkdtemp(join(tmpdir(), 'uniweb-html-appearance-'))
    await writeFile(join(root, 'site.yml'), 'name: S\n')
    await writeFile(join(root, 'theme.yml'), themeYml)
    await mkdir(join(root, 'pages', 'home'), { recursive: true })
    await writeFile(join(root, 'pages', 'home', '1-hero.md'), '---\ntype: Hero\n---\n# Home\n')
    const plugin = siteContentPlugin({ sitePath: './' })
    await plugin.configResolved({ root, publicDir: join(root, 'public'), build: { outDir: 'dist' }, command: 'build', mode: 'production', base: '/' })
    await plugin.buildStart()
    return plugin.transformIndexHtml(INDEX, {})
  }

  it('a site set to dark: the class alone, since its browser can change nothing', async () => {
    const html = await shellFor('appearance: dark\n')
    expect(html).toContain('<html lang="en" class="scheme-dark">')
    expect(html).not.toContain('id="uniweb-appearance"')
  })

  it('a dark site with a switch: the class, and the script for a visitor who chose light', async () => {
    const html = await shellFor('appearance:\n  default: dark\n  allowToggle: true\n')
    expect(html).toContain('<html lang="en" class="scheme-dark">')
    expect(html.match(/id="uniweb-appearance"/g)).toHaveLength(1)
  })

  it('a site that follows the system: the script alone', async () => {
    const html = await shellFor('appearance: system\n')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('id="uniweb-appearance"')
  })

  it('a light-only site: neither', async () => {
    const html = await shellFor('appearance: light\n')
    expect(html).toContain('<html lang="en">')
    expect(html).not.toContain('id="uniweb-appearance"')
  })
})
