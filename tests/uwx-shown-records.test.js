/**
 * Which queries' records a site's pages show live — what decides whether a published
 * site needs `records`. Never whether the site has records to sync.
 */
import { recordQueriesShown } from '../src/uwx/shown-records.js'

const doc = {
  settings: { fetch: { query: 'team', as: 'team' } },
  pages: [
    {
      fetch: [{ query: 'articles', as: 'articles' }],
      page_sections: [{ params: { fetch: { query: 'videos' } }, $children: [{ params: { fetch: { query: 'weather' } } }] }],
      $children: [{ fetch: { query: 'notes' } }],
    },
  ],
  queries: [
    { name: 'articles', schema: '@std/article' },
    { name: 'team', schema: '@acme/member' },
    { name: 'videos' }, // schema-less: its records ship as static files
    { name: 'weather', schema: '@acme/weather', source: { url: 'https://api.example' } }, // external
    { name: 'notes', schema: '@acme/note' },
    { name: 'unused', schema: '@acme/unused' }, // declared, fetched by no page
  ],
}

describe('recordQueriesShown', () => {
  it('a query a page, section or the site fetches, whose records have a schema and come from the folder', () => {
    expect(recordQueriesShown(doc)).toEqual(['articles', 'notes', 'team'])
  })

  it('nothing fetched, or nothing with a schema, is nothing shown', () => {
    expect(recordQueriesShown({ queries: doc.queries })).toEqual([])
    expect(recordQueriesShown({ pages: doc.pages, queries: [{ name: 'videos' }] })).toEqual([])
    expect(recordQueriesShown(null)).toEqual([])
  })
})
