/**
 * ⭐ A PULL WRITES A SECTION INTO THE FILE THAT HOLDS IT, AND LISTS IT BY THE NAME THE BUILD FINDS IT BY.
 *
 * A section file may name its section by its `id:` rather than its file name (`hero.md` holding
 * `id: banner`). Found that way, it must be listed by the name its file is found by — a `sections:`
 * entry naming the id finds no file, and the build renders the section out of place.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { siteContentDocumentToProject } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let SITE
afterEach(() => SITE && rmSync(SITE, { recursive: true, force: true }))

function project(files) {
  SITE = mkdtempSync(join(tmpdir(), 'uwx-pull-sections-'))
  for (const [rel, body] of Object.entries({ 'site.yml': 'name: Site\nindex: home\n', 'pages/home/page.yml': 'title: Home\n', ...files })) {
    mkdirSync(join(SITE, rel, '..'), { recursive: true })
    writeFileSync(join(SITE, rel), body)
  }
}
const section = (id, text) => ({ $id: id, stable_id: id, type: 'Section', content: markdownToProseMirror(`# ${text}`) })
const pull = (sections) =>
  siteContentDocumentToProject({
    siteRoot: SITE,
    prune: true,
    // The page as a push of `title: Home` sends it — no `id:`, so no `stable_id`.
    document: { info: { name: 'Site' }, pages: [{ $id: 'home', slug: { en: 'home' }, mode: 'page', title: { en: 'Home' }, is_index: true, page_sections: sections }] },
  })
const rendered = async () => (await collectSiteContent(SITE)).pages.find((p) => p.route === '/').sections.map((s) => s.stableId)
const pageYml = () => yaml.load(readFileSync(join(SITE, 'pages/home/page.yml'), 'utf8'))

describe('pull — the files a page’s sections live in', () => {
  it('⭐ a section found by its `id:` is listed by its file’s name, and renders in the pulled order', async () => {
    project({
      'pages/home/hero.md': '---\ntype: Section\nid: banner\n---\n\n# Banner\n',
      'pages/home/intro.md': '---\ntype: Section\n---\n\n# Intro\n',
      'pages/home/zed.md': '---\ntype: Section\n---\n\n# Zed\n',
    })
    pull([section('intro', 'Intro'), section('banner', 'Banner'), section('zed', 'Zed')])
    expect(pageYml().sections).toEqual(['intro', 'hero', 'zed', '...'])
    expect(await rendered()).toEqual(['intro', 'banner', 'zed'])
  })

  it('an author’s list that names numbered files keeps naming them', () => {
    const authored = 'title: Home\nsections: [1-hero, 2-story]\n'
    project({
      'pages/home/page.yml': authored,
      'pages/home/1-hero.md': '---\ntype: Section\n---\n\n# Hero\n',
      'pages/home/2-story.md': '---\ntype: Section\n---\n\n# Story\n',
    })
    pull([section('hero', 'Hero'), section('story', 'Story')])
    expect(readFileSync(join(SITE, 'pages/home/page.yml'), 'utf8')).toBe(authored)
  })
})
