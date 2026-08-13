/**
 * `knowledge:` pages reach one lane and not the other, and the reason is the
 * HOST rather than the flag.
 *
 *   link   → Uniweb hosting. A backend derives the agent corpus from the
 *            payload and gates the endpoint on an entitlement. Keep them.
 *   bundle → `uniweb export`, `uniweb deploy --host <adapter>`. Static hosts:
 *            no agent endpoint to read them, no gate to withhold them. Drop
 *            them — shipping them is disclosure with no consumer.
 *
 * Regression test for a measured leak (2026-08-13): before the split, a
 * knowledge page became a public `dist/<route>/index.html` and its body rode
 * in the `__SITE_CONTENT__` of every prerendered page, `404.html` included.
 *
 * The bundle half is asserted through `partitionKnowledgePages` — the same
 * function `plugin.js` applies — rather than by booting Vite. What the whole
 * pipeline does with it is measured end-to-end by the `/test-quick` flow; what
 * this pins is that the two lanes ask different questions of the same flag.
 */

import { buildSiteData } from '../src/site/build-site-data.js'
import { partitionKnowledgePages } from '@uniweb/projections'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('knowledge pages across the two site lanes', () => {
  let siteRoot
  let distDir

  beforeEach(() => {
    siteRoot = join(tmpdir(), `knowledge-lanes-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    distDir = join(siteRoot, 'dist')
    mkdirSync(siteRoot, { recursive: true })

    writeFileSync(join(siteRoot, 'site.yml'), `name: test-site\nfoundation: src\nindex: home\n`)
    writeFileSync(join(siteRoot, 'theme.yml'), `vars:\n  primary: '#000000'\n`)

    const home = join(siteRoot, 'pages', 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'page.yml'), `title: Home\n`)
    writeFileSync(join(home, '1-hero.md'), `---\ntype: Hero\n---\n\n# Welcome\n\nPublic copy.\n`)

    // A knowledge branch: the marker on the parent, a child that inherits it.
    const kb = join(siteRoot, 'pages', 'kb')
    mkdirSync(join(kb, 'pricing'), { recursive: true })
    writeFileSync(join(kb, 'page.yml'), `title: Agent Knowledge\nknowledge: true\n`)
    writeFileSync(join(kb, '1-overview.md'), `---\ntype: Hero\n---\n\n# KB\n\nFor the agent.\n`)
    writeFileSync(join(kb, 'pricing', 'page.yml'), `title: Pricing Playbook\n`)
    writeFileSync(
      join(kb, 'pricing', '1-playbook.md'),
      `---\ntype: Hero\n---\n\n# Pricing\n\nThe floor discount codename is zebranaut.\n`
    )
  })

  afterEach(() => {
    if (existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true })
  })

  describe('link lane — the payload a backend derives the corpus from', () => {
    it('keeps the knowledge branch, flag and body intact', async () => {
      await buildSiteData({ siteRoot, distDir })
      const content = JSON.parse(readFileSync(join(distDir, 'site-content.json'), 'utf8'))
      const routes = content.pages.map(p => p.route)

      expect(routes).toContain('/kb')
      expect(routes).toContain('/kb/pricing')
      expect(content.pages.find(p => p.route === '/kb').knowledge).toBe(true)
      expect(JSON.stringify(content)).toContain('zebranaut')
    })

    it('but keeps them out of the free projections it emits alongside', async () => {
      await buildSiteData({ siteRoot, distDir })
      const llms = readFileSync(join(distDir, 'llms.txt'), 'utf8')

      expect(llms).not.toContain('/kb')
      expect(llms).not.toContain('zebranaut')
      // Control: the public page IS listed, so the absences are selection and
      // not an index that failed to render.
      expect(llms).toContain('/index.md')
      expect(existsSync(join(distDir, 'kb.md'))).toBe(false)
      expect(existsSync(join(distDir, 'kb', 'pricing.md'))).toBe(false)
    })
  })

  describe('bundle lane — a host that serves files and nothing else', () => {
    it('partitions the whole branch away, cascade included', async () => {
      await buildSiteData({ siteRoot, distDir })
      const content = JSON.parse(readFileSync(join(distDir, 'site-content.json'), 'utf8'))

      // What plugin.js applies to everything it collects.
      const { knowledgePages, renderedPages } = partitionKnowledgePages(content.pages)

      expect(knowledgePages.map(p => p.route).sort()).toEqual(['/kb', '/kb/pricing'])
      expect(renderedPages.map(p => p.route)).not.toContain('/kb/pricing')
      // The child never carried the flag — it inherits by route prefix, which
      // is why the lane filter cannot be a `page.knowledge` test.
      expect(content.pages.find(p => p.route === '/kb/pricing').knowledge).toBeUndefined()
      expect(JSON.stringify(renderedPages)).not.toContain('zebranaut')
    })
  })
})
