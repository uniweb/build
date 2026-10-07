/**
 * A tagged data block, checked against the schema its component BOUND.
 *
 * The hole this closes: a component declares `data: { form: '@std/form' }`, an
 * author writes a ```yaml:form``` block, and nothing checked one against the
 * other. The join walked `section.fetch` — collections and fetches — so a schema
 * bound to a key that a tagged BLOCK fills was applied to nothing at all.
 * `@std/form` was written for exactly this case and had never run outside its own
 * contract test.
 *
 * Note what this pass does NOT do, because it is what keeps it safe: it adds no
 * registry and no naming rule. Concept blocks (`md:faq` → `@std/faq`) resolve by
 * convention and must stay silent when no such schema exists. This resolves by
 * the binding the component actually declared, so a tag nobody bound is simply
 * ungoverned and says nothing.
 */

import { describe, expect, it } from 'vitest'
import { validateTaggedDataBlocks } from '../src/validate-data.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

// One page, one section of type `Form`, carrying one tagged block.
const siteWith = (tag, data, { type = 'Form', language = 'yaml' } = {}) => ({
  pages: [
    {
      route: '/contact',
      sections: [
        {
          type,
          content: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
              { type: 'dataBlock', attrs: { tag, language, data } },
            ],
          },
        },
      ],
    },
  ],
})

const FORM = validateAndNormalizeSchema(
  { name: 'form', fields: { title: { type: 'string' }, fields: { type: 'object', values: { type: 'object', fields: { type: { type: 'string', required: true } } } } } },
  '@std/form'
)
const NAV = validateAndNormalizeSchema(
  { name: 'nav', sections: { items: { many: true, fields: { label: { type: 'string', required: true } } } } },
  '@std/nav'
)

// `Form` holds ONE form in its block, so its key says so (`single: true`, ruled 2026-10-07 [Diego]);
// `Nav`'s schema is a list, which its key holds as it is.
const foundation = { Form: { data: { form: { schema: '@std/form', single: true } } }, Nav: { data: { nav: '@std/nav' } } }
const schemas = { '@std/form': FORM, '@std/nav': NAV }
const run = (site) => validateTaggedDataBlocks(site, foundation, schemas)

describe('a bound tagged block is finally checked', () => {
  it('catches a control with no type — the case @std/form exists for', () => {
    const out = run(siteWith('form', { title: 'Contact', fields: { email: { label: 'Email' } } }))
    expect(out.violations.map((v) => `${v.field}:${v.rule}`)).toEqual(['fields.email.type:required'])
    expect(out.checked).toBe(1)
  })

  it('passes a well-formed block', () => {
    const out = run(siteWith('form', { title: 'Contact', fields: { email: { type: 'string' } } }))
    expect(out.violations).toEqual([])
  })

  it('attributes the finding to the page, section and fence', () => {
    const [v] = run(siteWith('form', { fields: { a: {} } })).violations
    expect(v.file).toBe('/contact › Form › yaml:form')
    expect(v.schema).toBe('@std/form')
    expect(v.users).toEqual([{ route: '/contact', section: 'Form', key: 'form' }])
  })
})

describe('a block whose value is a LIST', () => {
  it('checks each record and names its index', () => {
    // A list schema's block is its list — `validateItem` would have said nothing here.
    const site = siteWith('nav', [{ label: 'Home' }, { href: '/x' }], { type: 'Nav' })
    expect(run(site).violations.map((v) => `${v.field}:${v.rule}`)).toEqual(['[1].label:required'])
  })
})

// ⭐ A block holds what its key DECLARES — a list of records unless `single: true`, each its brief
// unless `whole: true` (ruled 2026-10-07 [Diego]). Until then the schema's root alone decided, so a
// block under a key typed by a record schema had to hold one record.
describe('a block holds what its key declares', () => {
  const ARTICLE = validateAndNormalizeSchema(
    {
      name: 'article',
      sections: {
        brief: { brief: true, fields: { title: { type: 'string', required: true } } },
        body: { fields: { content: { type: 'string' } } },
      },
    },
    '@std/article'
  )
  const declaring = (decl) => ({ Post: { data: { post: decl } } })
  const check = (decl, value) =>
    validateTaggedDataBlocks(siteWith('post', value, { type: 'Post' }), declaring(decl), { '@std/article': ARTICLE }).violations.map(
      (v) => `${v.field}:${v.rule}`
    )

  it('a list key holds a list — each record checked, by index', () => {
    expect(check('@std/article', [{ title: 'A' }, {}])).toEqual(['[1].title:required'])
    expect(check('@std/article', { title: 'A' })).toEqual([':type'])
  })

  it('a single key holds one record — and refuses a list', () => {
    expect(check({ schema: '@std/article', single: true }, { title: 'A' })).toEqual([])
    expect(check({ schema: '@std/article', single: true }, [{ title: 'A' }])).toEqual([':type'])
  })

  it('a whole key holds each record as stored — the brief under its name', () => {
    expect(check({ schema: '@std/article', single: true, whole: true }, { brief: { title: 'A' } })).toEqual([])
    expect(check({ schema: '@std/article', single: true, whole: true }, { title: 'A' })).toEqual(['brief.title:required'])
  })
})

describe('what it deliberately stays silent about', () => {
  it('an unbound tag — no naming rule, so nothing is governed by accident', () => {
    const out = run(siteWith('somethingElse', { anything: true }))
    expect(out.violations).toEqual([])
    expect(out.checked).toBe(0)
  })

  it('a section type the foundation does not declare data for', () => {
    expect(run(siteWith('form', { fields: { a: {} } }, { type: 'Unbound' })).violations).toEqual([])
  })

  it('a ref that resolves to no schema', () => {
    const out = validateTaggedDataBlocks(siteWith('form', { fields: { a: {} } }), foundation, {})
    expect(out.violations).toEqual([])
  })

  it('reports an inline binding as deferred rather than guessing at it', () => {
    const inline = { Form: { data: { form: { cpu: { type: 'string' } } } } }
    const out = validateTaggedDataBlocks(siteWith('form', {}), inline, schemas)
    expect(out.deferred).toEqual([
      { route: '/contact', section: 'Form', key: 'form', reason: 'inline schema on the binding' },
    ])
  })

  it('a malformed body never reaches here at all', () => {
    // A tagged fence whose body fails to parse becomes a `codeBlock`, not a
    // `dataBlock` — so bad YAML cannot be misreported as a schema violation.
    const site = siteWith('form', null)
    site.pages[0].sections[0].content.content[1] = {
      type: 'codeBlock',
      attrs: { language: 'yaml', tag: 'form' },
      content: [{ type: 'text', text: ': not: valid' }],
    }
    expect(run(site).checked).toBe(0)
  })
})

describe('it finds blocks wherever they sit', () => {
  it('nested inside other content', () => {
    const site = siteWith('form', { fields: { a: {} } })
    site.pages[0].sections[0].content.content = [
      { type: 'blockquote', content: [{ type: 'dataBlock', attrs: { tag: 'form', language: 'yaml', data: { fields: { a: {} } } } }] },
    ]
    expect(run(site).violations.map((v) => v.rule)).toEqual(['required'])
  })

  it('and reports the authored serialization in the label', () => {
    const [v] = run(siteWith('form', { fields: { a: {} } }, { language: 'json' })).violations
    expect(v.file).toContain('json:form')
  })
})
