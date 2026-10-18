/**
 * What a backend that cleans rich text at write removed from a push, read against what the
 * push sent (`uwx/cleaned.js`).
 *
 * A push's answer names each removal by its item's `$uuid`, its field and language, a JSON
 * Pointer into that field's document as sent, and the rule. Read against the document the push
 * sent, each says what went — in the build's own words where this version finds it too, and
 * as a removal this version keeps where it does not.
 */
import { siteContentRemovals, recordRemovals, cleanedRecord } from '../src/uwx/cleaned.js'
import { saysOutside } from '../src/site/vocabulary-warnings.js'

const doc = (...inline) => ({ type: 'doc', content: [{ type: 'paragraph', content: inline }] })
const plain = { type: 'text', text: 'Go' }
const linked = (href) => ({ type: 'text', text: 'Go', marks: [{ type: 'link', attrs: { href } }] })
const HREF = '/content/0/content/0/marks/0/attrs/href'

// A one-page site as the push sends it — no `$uuid`, as on a first push — and as the backend
// returns it, each item with the `$uuid` it holds it by.
const site = (content) => ({
  pages: [{ stable_id: 'home', slug: { en: 'home' }, page_sections: [{ type: 'Hero', stable_id: 'hero', content }] }],
})
const stored = (content) => ({
  $uuid: 'S1',
  pages: [
    {
      $uuid: 'U-home',
      stable_id: 'home',
      slug: { en: 'home' },
      page_sections: [{ $uuid: 'U-hero', type: 'Hero', stable_id: 'hero', content }],
    },
  ],
})

describe('siteContentRemovals — each removal, with the unit it came from', () => {
  it('one this version finds too is said as the build says it', () => {
    const removals = siteContentRemovals({
      sent: site(doc(linked('ftp://example.com/x'))),
      finalized: [
        {
          index: 0,
          document: stored(doc(plain)),
          cleaned: [{ $uuid: 'U-hero', field: 'data.content', path: HREF, rule: 'url' }],
        },
      ],
    })
    expect(removals).toEqual([
      {
        unit: 'pages/home/hero.md',
        locale: null,
        keeps: false,
        says: 'a link to `ftp://example.com/x` is never followed — the backend removed it',
      },
    ])
  })

  it('one this version keeps is said as such — the backend cleans to another vocabulary', () => {
    const inset = { type: 'inset_ref', attrs: { component: 'Chart', alt: null, embedKind: 'text' } }
    const [removal] = siteContentRemovals({
      sent: site(doc(inset)),
      finalized: [
        {
          index: 0,
          document: stored(doc({ type: 'inset_ref', attrs: { component: 'Chart', alt: null } })),
          cleaned: [{ $uuid: 'U-hero', field: 'data.content', path: '/content/0/content/0/attrs/embedKind', rule: 'attribute' }],
        },
      ],
    })
    expect(removal).toEqual({
      unit: 'pages/home/hero.md',
      locale: null,
      keeps: true,
      says: 'the backend removed the attribute `embedKind`, which this version of Uniweb keeps',
    })
  })

  it('a field in each language names the language', () => {
    const [removal] = siteContentRemovals({
      sent: site({ en: doc(linked('ftp://example.com/x')), fr: doc(plain) }),
      finalized: [
        {
          index: 0,
          document: stored({ en: doc(plain), fr: doc(plain) }),
          cleaned: [{ $uuid: 'U-hero', field: 'data.content.en', path: HREF, rule: 'url' }],
        },
      ],
    })
    expect([removal.unit, removal.locale, removal.keeps]).toEqual(['pages/home/hero.md', 'en', false])
  })

  it('an item the returned document does not hold is still said, with no unit', () => {
    const [removal] = siteContentRemovals({
      sent: site(doc(plain)),
      finalized: [
        {
          index: 0,
          document: stored(doc(plain)),
          cleaned: [{ $uuid: 'U-elsewhere', field: 'data.content', path: '/content/0', rule: 'node-type' }],
        },
      ],
    })
    expect(removal).toEqual({
      unit: null,
      locale: null,
      keeps: false,
      says: 'the backend removed what `/content/0` held in `data.content` (node-type)',
    })
  })

  it('CONTROL — an answer that removed nothing names nothing', () => {
    const sent = site(doc(plain))
    expect(siteContentRemovals({ sent, finalized: [{ index: 0, document: stored(doc(plain)) }] })).toEqual([])
    expect(siteContentRemovals({ sent, finalized: [{ index: 0, document: stored(doc(plain)), cleaned: [] }] })).toEqual([])
  })
})

describe('recordRemovals — each removal, with the position of the record it came from', () => {
  const sentRecord = {
    $id: 'talk/a',
    $schema: '@a/talk',
    talk: { title: 'A', abstract: doc(linked('ftp://example.com/x')) },
    sessions: [{ notes: doc(plain) }, { notes: doc(linked('ftp://example.com/y')) }],
  }
  const returned = {
    $uuid: 'R1',
    $schema: '@a/talk',
    talk: { $uuid: 'I-talk', title: 'A', abstract: doc(plain) },
    sessions: [
      { $uuid: 'I-s1', notes: doc(plain) },
      { $uuid: 'I-s2', notes: doc(plain) },
    ],
  }

  it('reads each against the item at the same place in the document sent', () => {
    const removals = recordRemovals({
      sent: [{ $schema: '@uniweb/folder' }, sentRecord],
      finalized: [
        { index: 0, document: { $uuid: 'F1' } },
        {
          index: 1,
          document: returned,
          cleaned: [
            { $uuid: 'I-talk', field: 'data.abstract', path: HREF, rule: 'url' },
            { $uuid: 'I-s2', field: 'data.notes', path: HREF, rule: 'url' },
          ],
        },
      ],
    })
    expect(removals.map((r) => [r.index, r.says])).toEqual([
      [1, 'a link to `ftp://example.com/x` is never followed — the backend removed it'],
      [1, 'a link to `ftp://example.com/y` is never followed — the backend removed it'],
    ])
  })
})

describe('cleanedRecord — what a backend that cleans at write stores for an item', () => {
  it('cleans each document, and each document of a field in each language', () => {
    const record = { type: 'Hero', stable_id: 'hero', content: { en: doc(linked('ftp://example.com/x')), fr: doc(plain) } }
    const cleaned = cleanedRecord(record)
    expect(cleaned.content.en).toEqual(doc({ type: 'text', text: 'Go', marks: [] }))
    expect(cleaned.content.fr).toBe(record.content.fr)
    expect(cleaned.stable_id).toBe('hero')
    expect(record.content.en).toEqual(doc(linked('ftp://example.com/x')))
  })

  it('CONTROL — a record with nothing outside is returned as it is', () => {
    const record = { type: 'Hero', content: doc(plain), params: { theme: 'dark' } }
    expect(cleanedRecord(record)).toBe(record)
  })
})

describe('a value as a message shows it', () => {
  it('a control character is escaped, and a long value cut short', () => {
    expect(saysOutside({ rule: 'url', found: 'ftp://x\u001b[2J' })).toBe('a link to `ftp://x\\u001b[2J` is never followed')
    const long = saysOutside({ rule: 'url', found: `data:text/plain,${'a'.repeat(200)}` })
    expect(long).toMatch(/^a link to `data:text\/plain,a+…` is never followed$/)
    expect(long.length).toBeLessThan(100)
  })
})
