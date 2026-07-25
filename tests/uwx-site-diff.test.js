import { diffSiteUnits, describeSiteDiff, computeUnitHashes, collectSiteUnits } from '../src/uwx/site-diff.js'

// File-level attribution behind the entity-grained staleness gate.
//
// Two properties are load-bearing and each has a bug behind it:
//  1. The unit is the FILE, not the page. Content is split one section per file, so
//     two people editing different sections of the SAME page have not conflicted.
//     Page granularity called that a conflict, and a false conflict leaves only
//     destructive moves — it pushes people toward --force.
//  2. Each side is judged against a base in its OWN representation. The backend's
//     copy of a unit is not byte-equal to ours, so a single shared base makes
//     untouched units look changed.

const section = (id, body) => ({
  type: 'Section', stable_id: id,
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
})
const page = (id, slug, sections, extra = {}) => ({
  mode: 'page', stable_id: id, slug: { en: slug }, title: { en: slug }, page_sections: sections, ...extra,
})
const doc = (...pages) => ({ $model: '@uniweb/site-content', pages })
// The same document as the backend stores it: fields we never emit, its own uuids.
const asRemote = (d) => JSON.parse(JSON.stringify(d, (k, v) =>
  (v && typeof v === 'object' && v.stable_id && v.type === 'Section')
    ? { ...v, params: { align: 'center' }, theme_override: null, $uuid: `u-${v.stable_id}` }
    : v))

describe('collectSiteUnits — the unit is the file', () => {
  it('yields one unit per projected file: page.yml plus each section', () => {
    const d = doc(page('h', 'home', [section('hero', 'A'), section('cta', 'B')]))
    expect([...collectSiteUnits(d).keys()].sort()).toEqual([
      'pages/home/cta.md', 'pages/home/hero.md', 'pages/home/page.yml',
    ])
  })

  it('walks nested sections and child pages, and names layout sections', () => {
    const d = {
      $model: '@uniweb/site-content',
      pages: [page('h', 'home', [{ ...section('grid', 'G'), $children: [section('card-a', 'A')] }], {
        $children: [page('c', 'child', [section('body', 'X')])],
      })],
      layout_sections: [section('header', 'H')],
    }
    const keys = [...collectSiteUnits(d).keys()].sort()
    expect(keys).toContain('pages/home/card-a.md')     // nested child, flat in the page dir
    expect(keys).toContain('pages/home/child/body.md') // child page's section
    expect(keys).toContain('pages/home/child/page.yml')
    expect(keys).toContain('layout/header.md')
  })

  it('uses folder.yml for a folder page and [param] for a dynamic one', () => {
    const d = {
      $model: '@uniweb/site-content',
      pages: [
        { mode: 'folder', stable_id: 'f', slug: { en: 'blog' } },
        page('d', 'entry', [section('article', 'X')], { is_dynamic: true, param_name: 'slug' }),
      ],
    }
    const keys = [...collectSiteUnits(d).keys()]
    expect(keys).toContain('pages/blog/folder.yml')
    expect(keys).toContain('pages/[slug]/article.md')
  })

  it('keeps units disjoint — a section edit does not also mark its page changed', () => {
    const before = doc(page('h', 'home', [section('hero', 'A')]))
    const after = doc(page('h', 'home', [section('hero', 'CHANGED')]))
    const b = computeUnitHashes(before), a = computeUnitHashes(after)
    expect(a['pages/home/hero.md']).not.toBe(b['pages/home/hero.md'])
    expect(a['pages/home/page.yml']).toBe(b['pages/home/page.yml'])
  })
})

describe('diffSiteUnits — different sections of one page are not a conflict', () => {
  it('attributes per section when both sides edited the SAME page', () => {
    // The case that motivated this. Page granularity reported `home` as
    // changed-on-both-sides; there is no conflict here at all.
    const base = doc(page('h', 'home', [section('hero', 'H0'), section('cta', 'C0')]))
    const local = doc(page('h', 'home', [section('hero', 'H-mine'), section('cta', 'C0')]))
    const remote = asRemote(doc(page('h', 'home', [section('hero', 'H0'), section('cta', 'C-theirs')])))

    const d = diffSiteUnits(local, remote, {
      local: computeUnitHashes(base), remote: computeUnitHashes(asRemote(base)),
    })
    expect(d.changedLocally).toEqual(['pages/home/hero.md'])
    expect(d.changedUpstream).toEqual(['pages/home/cta.md'])
    expect(d.changedBoth).toEqual([])
    expect(describeSiteDiff(d)).toContain('No unit was changed on both sides — pulling should merge cleanly.')
  })

  it('still reports a genuine conflict when both edited the SAME section', () => {
    const base = doc(page('h', 'home', [section('hero', 'H0')]))
    const local = doc(page('h', 'home', [section('hero', 'H-mine')]))
    const remote = asRemote(doc(page('h', 'home', [section('hero', 'H-theirs')])))
    const d = diffSiteUnits(local, remote, {
      local: computeUnitHashes(base), remote: computeUnitHashes(asRemote(base)),
    })
    expect(d.changedBoth).toEqual(['pages/home/hero.md'])
    expect(describeSiteDiff(d)).not.toContain('No unit was changed on both sides — pulling should merge cleanly.')
  })

  it('does NOT report an untouched unit as changed just because the sides serialize differently', () => {
    const d0 = doc(page('h', 'home', [section('hero', 'H')]))
    const d = diffSiteUnits(d0, asRemote(d0), {
      local: computeUnitHashes(d0), remote: computeUnitHashes(asRemote(d0)),
    })
    expect(d.identical.sort()).toEqual(['pages/home/hero.md', 'pages/home/page.yml'])
    expect(d.changedUpstream).toEqual([])
  })

  it('flags a section added upstream — forcing DELETES it rather than reverting it', () => {
    const base = doc(page('h', 'home', [section('hero', 'H')]))
    const remote = asRemote(doc(page('h', 'home', [section('hero', 'H'), section('news', 'added in the app')])))
    const d = diffSiteUnits(base, remote, {
      local: computeUnitHashes(base), remote: computeUnitHashes(asRemote(base)),
    })
    expect(d.addedUpstream).toEqual(['pages/home/news.md'])
    expect(describeSiteDiff(d)[0]).toMatch(/forcing DELETES these.*pages\/home\/news\.md/)
  })
})

describe('diffSiteUnits — honest degradation', () => {
  it('names the side it cannot judge instead of guessing', () => {
    const base = doc(page('h', 'home', [section('hero', 'H0')]))
    const d = diffSiteUnits(
      doc(page('h', 'home', [section('hero', 'mine')])),
      asRemote(doc(page('h', 'home', [section('hero', 'theirs')]))),
      { local: computeUnitHashes(base) }
    )
    expect(d.knowsRemote).toBe(false)
    expect(d.changedLocally).toEqual(['pages/home/hero.md'])
    expect(describeSiteDiff(d).join('\n')).toMatch(/No record of the backend's last state/)
  })

  it('still names added units with no bases at all', () => {
    const d = diffSiteUnits(
      doc(page('h', 'home', [section('hero', 'mine')])),
      asRemote(doc(page('h', 'home', [section('hero', 'x'), section('news', 'y')])))
    )
    expect(d.addedUpstream).toEqual(['pages/home/news.md'])
    expect(d.changedUnattributed).toContain('pages/home/hero.md')
  })

  it('treats a unit missing from a base as unknown, not unchanged', () => {
    const d = diffSiteUnits(
      doc(page('h', 'home', [section('hero', 'mine')])),
      asRemote(doc(page('h', 'home', [section('hero', 'theirs')]))),
      { local: { 'other': 'x' }, remote: { 'other': 'y' } }
    )
    expect(d.changedUnattributed).toContain('pages/home/hero.md')
    expect(d.identical).toEqual([])
  })

  it('caps a long list rather than letting it read as complete', () => {
    const many = Array.from({ length: 12 }, (_, i) => section(`s${i}`, 'x'))
    const d = diffSiteUnits(doc(page('h', 'home', [])), asRemote(doc(page('h', 'home', many))))
    expect(describeSiteDiff(d, { limit: 3 })[0]).toMatch(/… and 9 more/)
  })

  it('handles empty and malformed documents without throwing', () => {
    expect(diffSiteUnits(null, null).changedBoth).toEqual([])
    expect(collectSiteUnits({ pages: [{ no: 'slug' }] }).size).toBe(0)
    expect(describeSiteDiff(diffSiteUnits(doc(), doc()))).toEqual([])
  })
})
