/**
 * ⛔ A RUNTIME WITHOUT THE RULE STOPS WITH WHAT TO DO. The shell's look comes from
 * @uniweb/runtime's `writePageAppearance`, first in 1.6.2. Paired with an older runtime (one held
 * back while @uniweb/build moved, or a linked one whose SSR bundle predates it), every page threw
 * `(intermediate value) is not a function`, naming nothing: measured 2026-11-11 against 1.6.1's
 * bundle, on a light site as on a dark one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentPlugin } from '../src/site/plugin.js'

vi.mock('@uniweb/runtime/ssr', async (importOriginal) => ({
  ...(await importOriginal()),
  writePageAppearance: undefined,
}))

const INDEX = '<!doctype html><html lang="en"><head></head><body></body></html>'

describe('the site plugin, with a runtime older than its rule', () => {
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

  it('stops with the version it needs and the command that updates it', async () => {
    root = await mkdtemp(join(tmpdir(), 'uniweb-html-old-runtime-'))
    await writeFile(join(root, 'site.yml'), 'name: S\n')
    await writeFile(join(root, 'theme.yml'), 'appearance: dark\n')
    await mkdir(join(root, 'pages', 'home'), { recursive: true })
    await writeFile(join(root, 'pages', 'home', '1-hero.md'), '---\ntype: Hero\n---\n# Home\n')
    const plugin = siteContentPlugin({ sitePath: './' })
    await plugin.configResolved({ root, publicDir: join(root, 'public'), build: { outDir: 'dist' }, command: 'build', mode: 'production', base: '/' })
    await plugin.buildStart()

    await expect(plugin.transformIndexHtml(INDEX, {})).rejects.toThrow(
      /writePageAppearance[\s\S]*1\.6\.2 or later[\s\S]*npx uniweb@latest update --yes/
    )
  })
})
