import { diffSitePages, describeSiteDiff, computePageHashes, pageLabel } from '../src/uwx/site-diff.js'

// Page-level attribution behind the entity-grained staleness gate. The refusal can
// only say "the document moved"; this turns that into an account of which pages and
// which side moved them.
//
// The load-bearing property under test is that each side is judged against a base in
// its OWN representation. The backend's copy of a page is not byte-equal to ours
// (extra fields, its own key order), so a single shared base makes untouched pages
// look changed — the bug these tests exist to prevent coming back.

const page = (id, slug, body) => ({
  mode: 'page',
  stable_id: id,
  slug: { en: slug },
  title: { en: slug },
  page_sections: [{ type: 'Section', stable_id: slug, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] } }],
})
// The same page as the backend stores it: extra fields we never emit.
const asRemote = (p) => ({
  ...p,
  $uuid: `u-${p.stable_id}`,
  page_sections: p.page_sections.map((s) => ({ ...s, params: { align: 'center' }, theme_override: null, $uuid: `u-${s.stable_id}` })),
})
const doc = (...pages) => ({ $model: '@uniweb/site-content', pages })
const remoteDoc = (...pages) => doc(...pages.map(asRemote))

describe('diffSitePages — two bases, one per representation', () => {
  it('attributes each side correctly when both bases are present', () => {
    const localBase = computePageHashes(doc(page('h', 'home', 'H0'), page('a', 'about', 'A0'), page('c', 'contact', 'C0')))
    const remoteBase = computePageHashes(remoteDoc(page('h', 'home', 'H0'), page('a', 'about', 'A0'), page('c', 'contact', 'C0')))

    const local = doc(page('h', 'home', 'H-mine'), page('a', 'about', 'A0'), page('c', 'contact', 'C-mine'))
    const remote = remoteDoc(page('h', 'home', 'H0'), page('a', 'about', 'A-theirs'), page('c', 'contact', 'C-theirs'))

    const d = diffSitePages(local, remote, { local: localBase, remote: remoteBase })
    expect(d.changedLocally).toEqual(['home'])
    expect(d.changedUpstream).toEqual(['about'])
    expect(d.changedBoth).toEqual(['contact'])
    expect(d.changedUnattributed).toEqual([])
  })

  it('does NOT report an untouched page as changed just because the sides serialize differently', () => {
    // The regression. With one shared base every page here reads as "changed
    // upstream"; with per-representation bases, none do.
    const p = page('a', 'about', 'A0')
    const d = diffSitePages(doc(p), remoteDoc(p), {
      local: computePageHashes(doc(p)),
      remote: computePageHashes(remoteDoc(p)),
    })
    expect(d.identical).toEqual(['about'])
    expect(d.changedUpstream).toEqual([])
    expect(d.changedBoth).toEqual([])
  })

  it('flags a page added upstream — forcing DELETES it rather than reverting it', () => {
    const p = page('h', 'home', 'H')
    const d = diffSitePages(doc(p), remoteDoc(p, page('n', 'news', 'authored in the app')), {
      local: computePageHashes(doc(p)),
      remote: computePageHashes(remoteDoc(p)),
    })
    expect(d.addedUpstream).toEqual(['news'])
    expect(describeSiteDiff(d)[0]).toMatch(/forcing DELETES these.*news/)
  })

  it('separates a locally added page from an upstream one', () => {
    const h = page('h', 'home', 'H')
    const d = diffSitePages(doc(h, page('d', 'docs', 'mine')), remoteDoc(h, page('n', 'news', 'theirs')), {
      local: computePageHashes(doc(h)),
      remote: computePageHashes(remoteDoc(h)),
    })
    expect(d.addedLocally).toEqual(['docs'])
    expect(d.addedUpstream).toEqual(['news'])
  })
})

describe('diffSitePages — honest degradation', () => {
  it('reports the side it cannot judge instead of guessing, when the remote base is missing', () => {
    const d = diffSitePages(doc(page('h', 'home', 'mine')), remoteDoc(page('h', 'home', 'theirs')), {
      local: computePageHashes(doc(page('h', 'home', 'base'))),
    })
    expect(d.knowsRemote).toBe(false)
    expect(d.changedLocally).toEqual(['home'])
    expect(d.changedUpstream).toEqual([])
    expect(describeSiteDiff(d).join('\n')).toMatch(/No record of the backend's last state/)
  })

  it('reports nothing attributable with no bases at all, but still names added pages', () => {
    const d = diffSitePages(doc(page('h', 'home', 'mine')), remoteDoc(page('h', 'home', 'x'), page('n', 'news', 'y')))
    expect(d.knowsLocal).toBe(false)
    expect(d.knowsRemote).toBe(false)
    expect(d.addedUpstream).toEqual(['news']) // set membership needs no base
    expect(d.changedUnattributed).toEqual(['home'])
  })

  it('treats a page missing from a base as unknown, not as unchanged', () => {
    const d = diffSitePages(doc(page('h', 'home', 'mine')), remoteDoc(page('h', 'home', 'theirs')), {
      local: { 'other-page': 'x' }, remote: { 'other-page': 'y' },
    })
    expect(d.changedUnattributed).toEqual(['home'])
    expect(d.identical).toEqual([])
  })

  it('handles empty and malformed documents without throwing', () => {
    expect(diffSitePages(null, null).changedBoth).toEqual([])
    expect(diffSitePages(doc(), doc()).identical).toEqual([])
    expect(computePageHashes({ pages: [{ no: 'identity' }] })).toEqual({})
    expect(describeSiteDiff(diffSitePages(doc(), doc()))).toEqual([])
  })
})

describe('pageLabel', () => {
  it('prefers the slug, then the title, then the stable id', () => {
    expect(pageLabel(page('h', 'home', 'x'))).toBe('home')
    expect(pageLabel({ stable_id: 'h', title: { en: 'Home' } })).toBe('Home')
    expect(pageLabel({ stable_id: 'e5f6a7b8' })).toBe('e5f6a7b8')
  })
})
