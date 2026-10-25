/**
 * A statically built site's record pages in its projections (`site/record-projections.js`): each
 * record of a parametric page is a page of the site, listed and written as a host lists and writes
 * it. Until 2026-10-25 the static build listed none of them.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordProjections, routeOnDisk } from '../src/site/record-projections.js'

const roots = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A site with a talks list and its `[slug]` page, the list's records compiled under `dataRoot`. */
function talksSite(records, { whole = {} } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'record-projections-'))
  roots.push(dataRoot)
  mkdirSync(join(dataRoot, 'data', 'talks'), { recursive: true })
  writeFileSync(join(dataRoot, 'data', 'talks.json'), JSON.stringify(records))
  for (const [handle, record] of Object.entries(whole)) {
    writeFileSync(join(dataRoot, 'data', 'talks', `${handle}.json`), JSON.stringify(record))
  }
  const content = {
    config: {},
    pages: [
      { route: '/talks', title: 'Talks', fetch: { query: 'talks', path: '/data/talks.json', as: 'talks' }, sections: [] },
      { route: '/talks/:slug', parent: '/talks', isDynamic: true, title: 'Talk', sections: [] },
    ],
  }
  return { content, dataRoot }
}

describe('recordProjections', () => {
  test('⭐ each record is a page: a search entry, and a markdown page at its own route', () => {
    const { content, dataRoot } = talksSite(
      [
        { $name: 'getting-started', title: 'Getting Started', abstract: 'An introduction.' },
        { $name: 'deep-dive', title: 'Deep Dive', abstract: 'The details, in depth.' },
      ],
      { whole: { 'getting-started': { $name: 'getting-started', title: 'Getting Started', body: 'The whole talk.' } } }
    )
    const { indexes, entries, pages } = recordProjections(content, { dataRoot, locale: 'en' })

    expect(indexes).toHaveLength(1)
    expect(entries.map((entry) => [entry.type, entry.route, entry.title])).toEqual([
      ['record', '/talks/getting-started', 'Getting Started'],
      ['record', '/talks/deep-dive', 'Deep Dive'],
    ])
    expect(pages.map((page) => page.route)).toEqual(['/talks/getting-started', '/talks/deep-dive'])
    // The record's own file holds it whole, and that is what its page's markdown carries.
    expect(pages[0].markdown).toContain('The whole talk.')
    expect(pages[1].markdown).toContain('The details, in depth.')
  })

  test('a query with no compiled file has no record pages to list — a host’s records are its own', () => {
    const { content, dataRoot } = talksSite([{ $name: 'a', title: 'A' }])
    content.pages[0].fetch = { query: 'talks', as: 'talks' }
    expect(recordProjections(content, { dataRoot })).toEqual({ indexes: [], entries: [], pages: [] })
  })

  test('a site with no parametric page has none', () => {
    expect(recordProjections({ config: {}, pages: [{ route: '/', sections: [] }] }, { dataRoot: tmpdir() }).pages).toEqual([])
  })
})

describe('routeOnDisk', () => {
  test('a record’s URL route, decoded segment by segment for the file a static host serves it from', () => {
    expect(routeOnDisk('/libros/a%C3%B1o')).toBe('/libros/año')
    expect(routeOnDisk('/talks/getting-started')).toBe('/talks/getting-started')
    expect(routeOnDisk('/bad/%E0%A4%A')).toBe('/bad/%E0%A4%A')
  })
})
