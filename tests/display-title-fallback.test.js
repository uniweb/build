/**
 * The display-title fallback for a page whose author declared no title.
 *
 * The rule keys on whether the node has content of ITS OWN — the property the
 * page payload already carries as `hasContent` — and deliberately not on which
 * config file declared the folder. Keying on the declaration made a
 * content-less group node's name depend on how it happened to be written down:
 * a `page.yml` folder with no markdown came out prettified while a `folder.yml`
 * one came out verbatim, though both are the same group node in the payload and
 * render identically in nav.
 *
 * Regression this locks down: group nodes with an empty title rendering as
 * blank nav rows. The runtime has no fallback at all — `getTitle()` returns
 * `''` and a nav renders it. Empty-renders-empty is correct runtime behaviour;
 * the fill belongs to the producer.
 *
 * Note on naming: folders matching /^v\d+(\.\d+)?$/ are NOT usable as fixtures
 * here — `detectVersions` claims them as a versioned section, which is a
 * different feature with its own code path that emits no container page at all.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('page display title — fallback when the author declared none', () => {
  let siteDir

  async function build(files) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-title-'))
    await writeFile(join(siteDir, 'site.yml'), 'name: Test\nindex: home\n')
    const all = { 'pages/home/page.yml': 'title: Home\n', 'pages/home/body.md': '# Home\n', ...files }
    for (const [path, contents] of Object.entries(all)) {
      const full = join(siteDir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, contents)
    }
    const content = await collectSiteContent(siteDir)
    return Object.fromEntries(content.pages.map((p) => [p.route, p]))
  }

  afterEach(async () => {
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  it('gives a folder.yml group node the route segment verbatim', async () => {
    const pages = await build({
      'pages/handbook/folder.yml': 'pages: [guide]\n',
      'pages/handbook/guide.md': '# Guide\n',
    })

    // Verbatim, not prettified: a node with no content of its own has nothing
    // to humanize from, so it shows the identifier the author actually wrote.
    expect(pages['/handbook'].title).toBe('handbook')
    expect(pages['/handbook'].hasContent).toBe(false)
  })

  it('gives a page.yml folder with no markdown the segment verbatim too', async () => {
    // The case that used to diverge: declared with page.yml rather than
    // folder.yml, so it took the content-page branch and came out prettified
    // ("Field Notes") — despite being the same content-less group node in the
    // payload, rendering identically in nav.
    const pages = await build({
      'pages/field-notes/page.yml': 'description: A group\n',
      'pages/field-notes/entry/page.yml': 'title: Entry\n',
      'pages/field-notes/entry/body.md': '# Entry\n',
    })

    expect(pages['/field-notes'].title).toBe('field-notes')
    expect(pages['/field-notes'].hasContent).toBe(false)
  })

  it('takes the opening H1 of the first section when the node has content', async () => {
    const pages = await build({
      'pages/api-reference/page.yml': 'description: API\n',
      'pages/api-reference/intro.md': '# The API\n',
    })

    expect(pages['/api-reference'].title).toBe('The API')
    expect(pages['/api-reference'].hasContent).toBe(true)
  })

  it('prettifies the slug when a content node has no opening H1', async () => {
    const pages = await build({
      'pages/no-heading/page.yml': 'description: x\n',
      'pages/no-heading/body.md': 'Just a paragraph.\n',
    })

    expect(pages['/no-heading'].title).toBe('No Heading')
  })

  it('does not treat a level-2 opener as the title', async () => {
    // extractH1 matches level 1 exactly; an h2 opener falls through to the slug.
    const pages = await build({
      'pages/deep-dive/page.yml': 'description: x\n',
      'pages/deep-dive/body.md': '## Not The Title\n',
    })

    expect(pages['/deep-dive'].title).toBe('Deep Dive')
  })

  it('lets an author-declared title win in every shape', async () => {
    const pages = await build({
      'pages/handbook/folder.yml': 'title: The Handbook\npages: [guide]\n',
      'pages/handbook/guide.md': '# Guide\n',
      'pages/docs/page.yml': 'title: Documentation\n',
      'pages/docs/intro.md': '# Ignored Heading\n',
    })

    expect(pages['/handbook'].title).toBe('The Handbook')
    expect(pages['/docs'].title).toBe('Documentation')
  })

  it('never emits an empty title for a node the author left untitled', async () => {
    const pages = await build({
      'pages/handbook/folder.yml': 'pages: [guide]\n',
      'pages/handbook/guide.md': '# Guide\n',
      'pages/field-notes/page.yml': 'description: x\n',
      'pages/no-heading/page.yml': 'description: x\n',
      'pages/no-heading/body.md': 'Just a paragraph.\n',
    })

    for (const page of Object.values(pages)) {
      expect(page.title).toBeTruthy()
    }
  })
})
