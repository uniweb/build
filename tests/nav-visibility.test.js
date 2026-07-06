// normalizeHideIn — the shared page nav-visibility normalizer used by the
// content-collector (runtime page data) and the sync producer (the `hide_in` field).
// dropUnpublishedPages — the reachability-axis prune applied on published builds.

import { describe, it, expect } from 'vitest'
import { normalizeHideIn, dropUnpublishedPages } from '../src/site/nav-visibility.js'

describe('normalizeHideIn', () => {
  it('passes through an array of area names', () => {
    expect(normalizeHideIn({ hideIn: ['header', 'footer'] })).toEqual(['header', 'footer'])
  })

  it('accepts a single string for convenience', () => {
    expect(normalizeHideIn({ hideIn: 'footer' })).toEqual(['footer'])
  })

  it('folds the legacy hideInHeader/hideInFooter booleans', () => {
    expect(normalizeHideIn({ hideInHeader: true, hideInFooter: true })).toEqual(['header', 'footer'])
  })

  it('merges the array with the legacy booleans and dedupes', () => {
    expect(normalizeHideIn({ hideIn: ['header', 'sidebar'], hideInHeader: true })).toEqual(['header', 'sidebar'])
  })

  it('filters non-string entries and returns [] for empty/absent', () => {
    expect(normalizeHideIn({})).toEqual([])
    expect(normalizeHideIn({ hideIn: [null, 'header', 0, 'footer'] })).toEqual(['header', 'footer'])
  })
})

describe('dropUnpublishedPages (reachability cascade)', () => {
  const routes = (pages) => pages.map((p) => p.route)

  it('keeps every page when none is hidden', () => {
    const pages = [
      { route: '/', parent: null },
      { route: '/about', parent: null },
    ]
    expect(routes(dropUnpublishedPages(pages))).toEqual(['/', '/about'])
  })

  it('drops a hidden leaf page', () => {
    const pages = [
      { route: '/', parent: null },
      { route: '/wip', parent: null, hidden: true },
    ]
    expect(routes(dropUnpublishedPages(pages))).toEqual(['/'])
  })

  it('cascades: a hidden container removes its whole subtree', () => {
    const pages = [
      { route: '/', parent: null },
      { route: '/draft-section', parent: '/', hidden: true },
      { route: '/draft-section/a', parent: '/draft-section' },
      { route: '/draft-section/a/deep', parent: '/draft-section/a' },
      { route: '/live', parent: null },
    ]
    // the container, its child, and its grandchild all leave; siblings stay
    expect(routes(dropUnpublishedPages(pages))).toEqual(['/', '/live'])
  })

  it('leaves no surviving page pointing at a pruned parent', () => {
    const pages = [
      { route: '/', parent: null },
      { route: '/docs', parent: '/', hidden: true },
      { route: '/docs/guide', parent: '/docs' },
    ]
    const kept = dropUnpublishedPages(pages)
    const keptRoutes = new Set(kept.map((p) => p.route))
    for (const p of kept) {
      if (p.parent) expect(keptRoutes.has(p.parent)).toBe(true)
    }
  })

  it('a visible child of a visible parent under a hidden grandparent still drops', () => {
    const pages = [
      { route: '/', parent: null },
      { route: '/a', parent: '/', hidden: true },
      { route: '/a/b', parent: '/a' }, // visible flag, but ancestor /a is hidden
      { route: '/a/b/c', parent: '/a/b' },
    ]
    expect(routes(dropUnpublishedPages(pages))).toEqual(['/'])
  })

  it('is a no-op for empty/invalid input', () => {
    expect(dropUnpublishedPages([])).toEqual([])
    expect(dropUnpublishedPages(undefined)).toBe(undefined)
  })
})
