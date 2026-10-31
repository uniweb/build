/**
 * ⭐ `<html lang>` IS THE LANGUAGE THE PAGE IS IN, on a static build too.
 *
 * ⛔ Until 2026-10-30 only a translation's pages were rewritten, so a site written in Spanish built its
 * default pages as `lang="en"`, which is what the scaffold's `index.html` says. Measured on a site
 * with `defaultLanguage: es`; a hosted page already said `es` (`core/src/page-shell.js`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentPlugin } from '../src/site/plugin.js'

const INDEX = '<!doctype html><html lang="en"><head></head><body></body></html>'

describe('the site plugin states the page’s language', () => {
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

  async function htmlFor(yml) {
    root = await mkdtemp(join(tmpdir(), 'uniweb-html-lang-'))
    await writeFile(join(root, 'site.yml'), yml)
    await mkdir(join(root, 'pages', 'home'), { recursive: true })
    await writeFile(join(root, 'pages', 'home', '1-hero.md'), '---\ntype: Hero\n---\n# Home\n')
    const plugin = siteContentPlugin({ sitePath: './' })
    await plugin.configResolved({ root, publicDir: join(root, 'public'), build: { outDir: 'dist' }, command: 'build', mode: 'production', base: '/' })
    await plugin.buildStart()
    return plugin.transformIndexHtml(INDEX, {})
  }

  it('the default language a site names', async () => {
    expect(await htmlFor('name: S\ndefaultLanguage: es\n')).toContain('<html lang="es">')
  })

  it('the first of the languages it lists, when it names no default', async () => {
    expect(await htmlFor('name: S\nlanguages: [fr, en]\n')).toContain('<html lang="fr">')
  })

  it('a site that names none is in English, the rule for every other surface', async () => {
    expect(await htmlFor('name: S\n')).toContain('<html lang="en">')
  })
})
