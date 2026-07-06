// Integration: the two page-visibility axes flow through collectSiteContent.
//   • Reachability (`hidden`) — dropped (with its whole subtree) ONLY when the
//     published build passes `dropUnpublished: true`; kept in dev (default) so
//     drafts stay previewable.
//   • Nav placement (`hideIn: ['*']`) — the page stays routed in BOTH modes; it's
//     only suppressed from nav menus (verified at the runtime layer elsewhere).

import collectSiteContent from '../src/site/content-collector.js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('collectSiteContent — page visibility (hidden vs hideIn)', () => {
  let siteRoot

  const page = (dir, yml, body = '# Body') => {
    const p = join(siteRoot, 'pages', dir)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'page.yml'), yml)
    writeFileSync(join(p, '1-hero.md'), `---\ntype: Hero\n---\n\n${body}\n`)
  }

  beforeEach(() => {
    siteRoot = join(tmpdir(), `page-vis-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(siteRoot, { recursive: true })
    writeFileSync(join(siteRoot, 'site.yml'), `name: test-site\nindex: home\n`)
    writeFileSync(join(siteRoot, 'theme.yml'), `vars:\n  primary: '#000000'\n`)

    page('home', 'title: Home\n')
    page('live', 'title: Live\n')
    // Reachable-but-out-of-all-menus (nav axis).
    page('unlisted', "title: Unlisted\nhideIn: ['*']\n")
    // A draft container + a descendant — the whole subtree is unpublished.
    page('draft-section', 'title: Draft Section\nhidden: true\n')
    page('draft-section/child', 'title: Draft Child\n')

    // Strict `pages:` (no '...') — the unlisted sibling must be suppressed from
    // nav but stay ROUTED (migrated from the retired `hidden` flag to hideIn '*').
    const guide = join(siteRoot, 'pages', 'guide')
    mkdirSync(guide, { recursive: true })
    writeFileSync(join(guide, 'page.yml'), 'title: Guide\npages: [shown]\n')
    page('guide/shown', 'title: Shown\n')
    page('guide/strict-unlisted', 'title: Strict Unlisted\n')
  })

  afterEach(() => {
    if (existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true })
  })

  const routesOf = (pages) => pages.map((p) => p.route).sort()

  it('dev (default) keeps hidden pages so drafts stay previewable', async () => {
    const { pages } = await collectSiteContent(siteRoot)
    const routes = routesOf(pages)
    expect(routes).toContain('/draft-section')
    expect(routes).toContain('/draft-section/child')
    expect(routes).toContain('/unlisted')
    expect(routes).toContain('/live')
  })

  it('published build drops a hidden page AND its subtree (cascade)', async () => {
    const { pages } = await collectSiteContent(siteRoot, { dropUnpublished: true })
    const routes = routesOf(pages)
    expect(routes).not.toContain('/draft-section')
    expect(routes).not.toContain('/draft-section/child')
    // sibling + nav-suppressed pages survive
    expect(routes).toContain('/live')
    expect(routes).toContain('/unlisted')
    // no surviving page points at a pruned parent
    const kept = new Set(routes)
    for (const p of pages) {
      if (p.parent) expect(kept.has(p.parent)).toBe(true)
    }
  })

  it("hideIn ['*'] page stays routed in the published build (nav-only, not reachability)", async () => {
    const { pages } = await collectSiteContent(siteRoot, { dropUnpublished: true })
    const unlisted = pages.find((p) => p.route === '/unlisted')
    expect(unlisted).toBeTruthy()
    expect(unlisted.hidden).toBeFalsy()
    expect(unlisted.hideIn).toContain('*')
  })

  it('strict pages: suppresses the unlisted sibling via hideIn [*] but keeps it routed', async () => {
    const { pages } = await collectSiteContent(siteRoot, { dropUnpublished: true })
    const strictUnlisted = pages.find((p) => p.route === '/guide/strict-unlisted')
    // survives the published build (nav axis, not reachability)
    expect(strictUnlisted).toBeTruthy()
    expect(strictUnlisted.hidden).toBeFalsy()
    expect(strictUnlisted.hideIn).toContain('*')
    // the listed sibling is not suppressed
    const shown = pages.find((p) => p.route === '/guide/shown')
    expect(shown).toBeTruthy()
    expect(shown.hideIn || []).not.toContain('*')
  })
})
