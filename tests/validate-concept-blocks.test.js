/**
 * Concept-block conformance: ```md:<tag> checked against `@std/<tag>`, when that
 * schema exists.
 *
 * The three properties this has to keep, each with a test below:
 *
 *   1. no registry  — nothing branches on a tag's value; the `@std/<tag>`
 *                     derivation is mechanical and the tag stays opaque
 *   2. never shapes  — a block with no resolvable schema parses and delivers
 *                     exactly as before; the schema is a check, never a gate
 *   3. never fails   — findings only, and silence when nothing resolves
 *
 * `@uniweb/schemas` is mocked rather than extended, and it will stay mocked: no
 * `@std` schema is written for a PROSE concept, because none can produce a
 * finding. See the ⛔ note in the source — the item vocabulary is total so
 * `required` is inert, and `alwaysItems` keeps `title` a string so `type` cannot
 * fail either. The contrived `format: 'url'` below is what that costs: it exists
 * only to prove the plumbing, and needing to invent it is the evidence.
 *
 * The mechanism is the deliverable. The trigger to write an actual schema is a
 * concept that carries a tagged DATA BLOCK, where the facets bite for real.
 */

import { vi } from 'vitest'

// A standard schema authored the ONLY way one may be: in the item vocabulary
// the parse actually produces (`title`, `paragraphs`), not in domain field
// names like `{ question, answer }`. A schema in domain names could only be
// checked with a per-concept field mapping, which is the forbidden registry
// arriving through the back door.
// `format` rather than `required` is deliberate, and the reason is a finding
// worth carrying: the item vocabulary is TOTAL. `flattenGroup` fills every
// field it declares — `title: ''`, `paragraphs: []` — so no field is ever
// absent, and `required` (which fires only on an absent or null value) is inert
// against a parsed item. A schema author who writes `required: true` expecting
// "the author actually wrote a question" gets silence. The facets that bite
// here are the ones about a value's SHAPE. `format: 'url'` on a question is
// contrived; it is standing in for a real one so the plumbing is proven.
const FAQ = {
  name: 'faq',
  fields: {
    title: { type: 'string', format: 'url' },
    paragraphs: { type: 'array', items: { type: 'string' } },
  },
}

vi.mock('@uniweb/schemas', () => ({
  schemas: { faq: FAQ },
  getSchema: (name) => ({ faq: FAQ })[name],
}))

const { validateConceptBlocks } = await import('../src/validate-data.js')

const h = (text) => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] })
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

const siteWith = (...blocks) => ({
  pages: [{
    route: '/faq',
    sections: [{ type: 'Faq', content: { type: 'doc', content: blocks } }],
  }],
})

const concept = (tag, ...content) => ({ type: 'concept_block', attrs: { tag }, content })

describe('validateConceptBlocks', () => {
  it('passes a conformant block', async () => {
    const site = siteWith(concept('faq', h('https://example.com/q'), p('An answer.')))
    const report = await validateConceptBlocks(site)

    expect(report.violations).toEqual([])
    expect(report.checked).toBe(1)
    expect([...report.schemas]).toEqual(['@std/faq'])
  })

  it('flags an item whose value fails a declared facet', async () => {
    const site = siteWith(concept('faq', h('Not a URL'), p('An answer.')))
    const report = await validateConceptBlocks(site)

    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].field).toBe('title')
    expect(report.violations[0].rule).toBe('format')
    expect(report.violations[0].schema).toBe('@std/faq')
  })

  it('`required` is INERT against a parsed item — the vocabulary is total', async () => {
    // Worth its own test because it is counter-intuitive and a schema author
    // will reach for it first. The parser fills every field it declares, so
    // `title` is '' rather than absent, and `required` fires only on absent or
    // null. A headingless block — a callout, or an answer with no question —
    // produces a titleless item and NO required finding.
    const site = siteWith(concept('faq', p('An answer with no question.')))
    const report = await validateConceptBlocks(site)

    expect(report.checked).toBe(1)
    // The empty title still fails `format`, which is a SHAPE facet. Nothing
    // reports the field as missing, because it is not missing.
    expect(report.violations.map((v) => v.rule)).not.toContain('required')
  })

  it('checks EVERY item, and says which one', async () => {
    const site = siteWith(
      concept('faq', h('https://example.com/ok'), p('A1'), h('Not a URL'), p('A2'))
    )
    const report = await validateConceptBlocks(site)

    expect(report.checked).toBe(2)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].item).toBe('item 2')
  })

  it('says NOTHING for a tag with no standard schema', async () => {
    // Property 3. An unknown concept is not an error — most tags will never
    // have a standard schema, and that is the normal case, not a gap.
    const site = siteWith(concept('zzz-nobody-has-this', p('Just prose.')))
    const report = await validateConceptBlocks(site)

    expect(report.violations).toEqual([])
    expect(report.checked).toBe(0)
    expect([...report.schemas]).toEqual([])
  })

  it('derives the ref mechanically — no list of known concepts', async () => {
    // Property 1, stated as a test: the only reason `faq` is checked and
    // `warning` is not is that one resolves and the other does not. Nothing
    // here knows what either word means.
    const site = siteWith(
      concept('faq', h('https://example.com/q'), p('A')),
      concept('warning', h('Not a URL'), p('Back up first.'))
    )
    const report = await validateConceptBlocks(site)

    // `warning` has no standard schema, so its non-URL title is never looked
    // at. The asymmetry comes entirely from what resolves.
    expect([...report.schemas]).toEqual(['@std/faq'])
    expect(report.violations).toEqual([])
  })

  it('reaches a block nested inside a container', async () => {
    const site = siteWith({
      type: 'inset_block',
      attrs: { component: 'Panel' },
      content: [concept('faq', h('Not a URL'), p('Body.'))],
    })
    const report = await validateConceptBlocks(site)

    expect(report.violations).toHaveLength(1)
  })

  it('attributes a finding to the page, section and tag', async () => {
    const site = siteWith(concept('faq', h('Not a URL'), p('Body.')))
    const report = await validateConceptBlocks(site)

    expect(report.violations[0].file).toBe('/faq › Faq › md:faq')
    expect(report.violations[0].users).toEqual([
      { route: '/faq', section: 'Faq', key: 'faq' },
    ])
  })

  it('a site with no concept blocks costs nothing and reports nothing', async () => {
    const report = await validateConceptBlocks(siteWith(h('Just a heading'), p('And prose.')))

    expect(report).toEqual({ violations: [], schemas: new Set(), checked: 0 })
  })

  it('tolerates malformed input rather than throwing', async () => {
    // This is a pre-live gate, and a gate that crashes on odd input is worse
    // than one that stays quiet.
    for (const site of [{}, { pages: [] }, { pages: [{ sections: null }] }]) {
      await expect(validateConceptBlocks(site)).resolves.toBeTruthy()
    }
  })
})
