/**
 * The icon manifest names icons, never the files that use them (2026-10-28).
 *
 * It carried `bySource` until then: for each icon, the absolute path of every page
 * file using it — the build machine's home directory and folder layout, inlined in
 * every page's payload, and read by nothing. Prerender reads `icons.used`.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSiteData } from '../src/site/build-site-data.js'
import { collectSectionIcons, mergeIconCollections, buildIconManifest } from '../src/site/icons.js'

const iconDoc = (name) => ({
  type: 'doc',
  content: [{ type: 'image', attrs: { role: 'icon', library: 'lu', name } }],
})

describe('the icon manifest', () => {
  it('lists the icons used, their families and their count — nothing else', () => {
    const merged = mergeIconCollections(
      collectSectionIcons({ content: iconDoc('house') }),
      collectSectionIcons({ content: iconDoc('globe') }),
      collectSectionIcons({ content: iconDoc('house') })
    )
    expect(buildIconManifest(merged)).toEqual({ used: ['lu:globe', 'lu:house'], families: ['lu'], count: 2 })
  })

  describe('in a built site', () => {
    let siteRoot

    beforeEach(() => {
      siteRoot = join(tmpdir(), `icon-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      mkdirSync(join(siteRoot, 'pages', 'home'), { recursive: true })
      writeFileSync(join(siteRoot, 'site.yml'), 'name: test-site\nfoundation: src\nindex: home\n')
      writeFileSync(join(siteRoot, 'pages', 'home', '1-hero.md'), '---\ntype: Hero\n---\n\n# Welcome\n\n![](lu-house)\n')
    })

    afterEach(() => {
      rmSync(siteRoot, { recursive: true, force: true })
    })

    it('holds no path of the machine that built it', async () => {
      const distDir = join(siteRoot, 'dist')
      await buildSiteData({ siteRoot, distDir })
      const written = readFileSync(join(distDir, 'site-content.json'), 'utf8')
      // Control: the icon is in the manifest, so there was a file to name.
      expect(JSON.parse(written).icons.used).toEqual(['lu:house'])
      expect(written).not.toContain(siteRoot)
    })
  })
})
