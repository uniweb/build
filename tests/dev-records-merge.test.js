/**
 * The merge of one key's answer from a project's record files and a backend's public records —
 * eight vectors, each the answer a site's records service gives for the same two sources.
 */
import { mergeKey } from '../src/dev/records-merge.js'

const ids = (answer) => answer.records.map((r) => r.$uuid ?? r.$name)
const r = (id, fields = {}) => ({ $uuid: id, ...fields })
const f = (name, fields = {}) => ({ $name: name, ...fields })
const schema = '@acme/event'

describe('mergeKey', () => {
  it('V1 · a record in both sources is kept once, and the files’ copy wins', () => {
    const out = mergeKey(
      { schema },
      { files: { records: [r('a'), r('b', { title: 'B, files' })] }, engine: { records: [r('b', { title: 'B, engine' }), r('c')] } }
    )
    expect(ids(out)).toEqual(['a', 'b', 'c'])
    expect(out.records[1].title).toBe('B, files')
  })

  it('V2 · with no sort, the files’ records in their order, then the backend’s', () => {
    const out = mergeKey({ schema }, { files: { records: [f('f2'), f('f1')] }, engine: { records: [r('e2'), r('e1')] } })
    expect(ids(out)).toEqual(['f2', 'f1', 'e2', 'e1'])
  })

  it('V3 · texts sort in the question’s locale, and no value sorts last', () => {
    const out = mergeKey(
      { schema, sort: 'title' },
      { files: { records: [f('apple', { title: 'apple' }), f('zoo', { title: 'Zoo' })] }, engine: { records: [r('ete', { title: 'Été' }), r('blank', { title: '' })] } },
      'fr'
    )
    expect(ids(out)).toEqual(['apple', 'ete', 'zoo', 'blank'])
  })

  it('V4 · descending, and no value still last', () => {
    const out = mergeKey(
      { schema, sort: '-capacity' },
      { files: { records: [f('ten', { capacity: 10 }), f('none', { capacity: null })] }, engine: { records: [r('twentyfive', { capacity: 25 })] } }
    )
    expect(ids(out)).toEqual(['twentyfive', 'ten', 'none'])
  })

  it('V5 · the cut comes after the order', () => {
    const out = mergeKey(
      { schema, sort: 'n', limit: 3 },
      { files: { records: [f('f1', { n: 1 }), f('f3', { n: 3 })] }, engine: { records: [r('e2', { n: 2 }), r('e4', { n: 4 })] } }
    )
    expect(ids(out)).toEqual(['f1', 'e2', 'f3'])
  })

  it('V6 · a date sort interleaves only when the files’ records hold `date`', () => {
    const engine = { records: [r('e-jun', { date: '2026-06-01' })] }
    const withDate = mergeKey({ schema, sort: 'date' }, { files: { records: [f('f-may', { date: '2026-05-01' }), f('f-jul', { date: '2026-07-01' })] }, engine })
    expect(ids(withDate)).toEqual(['f-may', 'e-jun', 'f-jul'])
    const without = mergeKey({ schema, sort: 'date' }, { files: { records: [f('f-may'), f('f-jul')] }, engine })
    expect(ids(without)).toEqual(['f-may', 'f-jul', 'e-jun'])
  })

  it('V7 · whole when every source that delivered records delivered them whole; an empty source doesn’t decide', () => {
    const files = { records: [f('f')], whole: true }
    expect(mergeKey({ schema, whole: true }, { files, engine: { records: [r('e')], whole: false } }).whole).toBe(false)
    expect(mergeKey({ schema, whole: true }, { files, engine: { records: [] } }).whole).toBe(true)
  })

  it('V8 · a key pages only when exactly one source contributed records', () => {
    const engine = { records: [r('e1'), r('e2')], cursor: 'engine-token' }
    const one = mergeKey({ schema, narrow: { limit: 2 } }, { files: { records: [] }, engine })
    expect(one.cursor).toEqual({ source: 'engine', at: 'engine-token' })
    const two = mergeKey({ schema, narrow: { limit: 2 } }, { files: { records: [f('f1')] }, engine: { records: [r('e1')], cursor: 'engine-token' } })
    expect(two.cursor).toBeNull()
  })

  it('a locale list collates by its first tag', () => {
    const out = mergeKey(
      { schema, sort: 'title' },
      { files: { records: [f('zoo', { title: 'Zoo' }), f('apple', { title: 'apple' })] }, engine: { records: [r('ete', { title: 'Été' })] } },
      'fr,en'
    )
    expect(ids(out)).toEqual(['apple', 'ete', 'zoo'])
  })
})
