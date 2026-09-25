/**
 * ⭐ WHICH STORED RECORD EACH OF A COPY'S RECORDS IS — for a copy whose map lost the answer.
 *
 * Measured 2026-09-25 on a blog site whose `sync.json` held neither `records` nor `folders`: its
 * three articles went out with no `$uuid`, so the folder placing them was refused, and had it not
 * been, the backend would have made a second entity of each.
 */
import { matchStoredRecords } from '../src/uwx/index.js'

const ref = (name, schema, entity) => ({ kind: 'ref', name, entry: { schema, entity } })
const FOLDER = {
  contents: [
    ref('designing', '@std/article', 'T1'),
    ref('start', '@std/article', 'T2'),
    { kind: 'branch', name: 'team', $children: [ref('wei', '@acme/member', 'T3')] },
  ],
}

describe('matchStoredRecords', () => {
  it('⭐ by the own id the first backend minted, else by Model and slug', () => {
    const learned = matchStoredRecords({
      folderDoc: FOLDER,
      index: [
        { ownId: 'U1', model: '@std/article', slug: 'designing' },
        { ownId: 'T2', model: '@std/article', slug: 'renamed-since' },
        { ownId: 'U3', model: '@acme/member', slug: 'wei' },
        { ownId: 'U4', model: '@std/article', slug: 'new-one' },
        { ownId: null, model: '@std/article', slug: 'never-synced' },
        { kind: 'folder' },
      ],
    })
    expect(learned).toEqual({ U1: 'T1', T2: 'T2', U3: 'T3' })
  })

  it('a record the map already names is left alone', () => {
    const learned = matchStoredRecords({
      folderDoc: FOLDER,
      recordMap: { U1: 'T1' },
      index: [{ ownId: 'U1', model: '@std/article', slug: 'designing' }],
    })
    expect(learned).toEqual({})
  })

  it('⛔ CONTROL — a stored record the map gives to another is not taken again', () => {
    const learned = matchStoredRecords({
      folderDoc: FOLDER,
      recordMap: { OTHER: 'T1' },
      index: [{ ownId: 'U1', model: '@std/article', slug: 'designing' }],
    })
    expect(learned).toEqual({})
  })

  it('⛔ CONTROL — a Model and slug two stored records share names neither', () => {
    const learned = matchStoredRecords({
      folderDoc: {
        contents: [
          { kind: 'branch', name: 'a', $children: [ref('same', '@std/article', 'T1')] },
          { kind: 'branch', name: 'b', $children: [ref('same', '@std/article', 'T2')] },
        ],
      },
      index: [{ ownId: 'U1', model: '@std/article', slug: 'same' }],
    })
    expect(learned).toEqual({})
  })
})
