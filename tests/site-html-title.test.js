/**
 * ⭐ THE SHELL'S TITLE IS THE SITE'S NAME, on a static build as on a hosted page.
 *
 * A page writes its own title over it, so this is what shows where no page does: `404.html`, a site
 * that does not prerender, a tab before the bundle runs. ⛔ Until 2026-10-31 it stayed what the
 * scaffold's `index.html` says, the project folder's name: `<title>docs</title>` on a site named
 * "Documentation", measured in a real `dist/404.html`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentPlugin } from '../src/site/plugin.js'

const INDEX = '<!doctype html><html lang="en"><head><title>my-folder</title></head><body></body></html>'

describe('the site plugin titles the shell', () => {
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

  async function htmlFor(yml, index = INDEX) {
    root = await mkdtemp(join(tmpdir(), 'uniweb-html-title-'))
    await writeFile(join(root, 'site.yml'), yml)
    await mkdir(join(root, 'pages', 'home'), { recursive: true })
    await writeFile(join(root, 'pages', 'home', '1-hero.md'), '---\ntype: Hero\n---\n# Home\n')
    const plugin = siteContentPlugin({ sitePath: './' })
    await plugin.configResolved({ root, publicDir: join(root, 'public'), build: { outDir: 'dist' }, command: 'build' })
    await plugin.buildStart()
    return plugin.transformIndexHtml(index, {})
  }

  it("with the site's name, over the folder's", async () => {
    const html = await htmlFor('name: Documentation\n')
    expect(html).toContain('<title>Documentation</title>')
    expect(html).not.toContain('my-folder')
  })

  it('escaped, since a name is text', async () => {
    expect(await htmlFor('name: "Rosa & <Hijos> $1"\n')).toContain('<title>Rosa &amp; &lt;Hijos&gt; $1</title>')
  })

  it('leaving the title it has when the site names nothing', async () => {
    // CONTROL: the replacement above is the site's name, not a rule that empties a title.
    expect(await htmlFor('languages: [en]\n')).toContain('<title>my-folder</title>')
  })

  it('adding none where the shell has none', async () => {
    const bare = '<!doctype html><html lang="en"><head></head><body></body></html>'
    expect(await htmlFor('name: S\n', bare)).not.toContain('<title>')
  })
})
