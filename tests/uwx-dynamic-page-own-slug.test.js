/**
 * A parametric page's OWN slug survives a round trip through files.
 *
 * A page made in an app may have a slug of its own beside its route param — `slug: detail`,
 * `param_name: id`. On disk its folder is named by the param (`[id]`), so its own slug has no
 * place there but its `page.yml`. ⛔ Until 2026-09-30 a pull dropped it and the next push sent
 * `slug: id`: an authored value lost on a round trip (`uwx-format.md` § THE ROUND-TRIP LAW).
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteContentDocumentToProject, siteProjectToDocument } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let SITE
afterEach(() => SITE && rmSync(SITE, { recursive: true, force: true }))

const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const page = (slug, extra = {}) => ({
  $id: slug,
  slug: { en: slug },
  mode: 'page',
  title: { en: slug },
  page_sections: [{ $id: `${slug}-s`, stable_id: `${slug}-s`, type: 'Section', content: docOf(slug) }],
  ...extra,
})

function pullSite(children) {
  SITE = mkdtempSync(join(tmpdir(), 'uwx-own-slug-'))
  siteContentDocumentToProject({
    siteRoot: SITE,
    document: { info: { name: 'Site', foundation: '@acme/marketing@1.0.0' }, pages: [page('home', { is_index: true }), page('articles', { $children: children })] },
  })
}
const yml = (rel) => yaml.load(readFileSync(join(SITE, rel), 'utf8')) || {}
const pushed = async (slugPath) => {
  const doc = await siteProjectToDocument(SITE)
  const walk = (pages, at) => {
    for (const p of pages || []) {
      if (at.length === 1 && (p.param_name ?? p.slug.en) === at[0]) return p
      if (p.slug.en === at[0]) return walk(p.$children, at.slice(1))
    }
    return null
  }
  return walk(doc.pages, slugPath)
}

describe('a parametric page’s own slug', () => {
  it('⭐ is written to its page.yml, and a push sends it back', async () => {
    pullSite([page('detail', { is_dynamic: true, param_name: 'id' })])
    expect(existsSync(join(SITE, 'pages/articles/[id]/page.yml'))).toBe(true)
    expect(yml('pages/articles/[id]/page.yml').slug).toBe('detail')

    const record = await pushed(['articles', 'id'])
    expect(record).toMatchObject({ slug: { en: 'detail' }, is_dynamic: true, param_name: 'id' })
  })

  it('does not move the route: the folder, and so the page, is the param’s', async () => {
    pullSite([page('detail', { is_dynamic: true, param_name: 'id' })])
    const routes = (await collectSiteContent(SITE)).pages.map((p) => p.route)
    expect(routes).toContain('/articles/:id')
    expect(routes).not.toContain('/articles/:detail')
  })

  it('writes nothing when the slug is the param, or for the catch-all', async () => {
    pullSite([page('slug', { is_dynamic: true, param_name: 'slug' }), page('...path', { is_dynamic: true, param_name: 'slug' })])
    expect(yml('pages/articles/[slug]/page.yml').slug).toBeUndefined()
    expect(yml('pages/articles/[...path]/page.yml').slug).toBeUndefined()
    expect(await pushed(['articles', 'slug'])).toMatchObject({ slug: { en: 'slug' }, param_name: 'slug' })
  })
})
