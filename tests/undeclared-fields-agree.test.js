// ⭐ ONE RULE, READ IN TWO PLACES. `uniweb validate` finds the keys a record file holds that its
// schema has no place for with `@uniweb/schemas/conform`'s `undeclaredFields` (beside
// `misplacedFields`, the retired flat form), over the normalized schema. The push finds them while
// it encodes the record against its Model's declaration (`uwx/records.js`), the only check a site
// whose foundation is not local gets. Both must name the same keys: until 2026-11-11 only the push
// looked, and a site whose records passed `uniweb validate` and built was refused at its first push.
//
// ⚠️ A `$` key at the top of a record written by section is left out: the push refuses it and the
// check passes it, a difference not yet decided.
import { describe, expect, it } from 'vitest'
import { recordsToEntities } from '../src/uwx/records.js'
import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { undeclaredFields, misplacedFields } from '@uniweb/schemas/conform'

const SCHEMAS = {
  quote: { name: 'quote', fields: { quote: 'text', name: { type: 'string', required: true } } },
  venue: {
    name: 'venue',
    fields: {
      title: 'string',
      address: { type: 'object', fields: { city: 'string', zip: 'string' } },
      speakers: { type: 'array', items: { type: 'object', fields: { name: 'string' } } },
      photo: 'image',
      extra: 'json',
      tags: { type: 'array', items: 'string' },
    },
  },
  page: { name: 'page', sections: { only: { fields: { title: 'string' }, sections: { links: { many: true, fields: { href: 'string' } } } } } },
  course: {
    name: 'course',
    sections: {
      identity: { brief: true, fields: { title: 'string' } },
      pricing: { fields: { amount: 'number' } },
      modules: { many: true, fields: { title: 'string', minutes: 'number' }, sections: { lessons: { many: true, fields: { title: 'string' } } } },
      more: { sections: { faq: { many: true, tree: true, fields: { q: 'string' } } } },
    },
  },
}

const RECORDS = {
  quote: [
    { quote: 'Hi', name: 'Ada' },
    { quote: 'Hi', name: 'Ada', order: 3, logo: 'claude.svg', draft: true, $uuid: 'u' },
    { quote: 'Hi', $meta: { a: 1 } },
  ],
  venue: [
    { title: 'Hall', address: { city: 'Ottawa', zip: 'K1A' }, speakers: [{ name: 'Ada' }] },
    { title: 'Hall', address: { city: 'Ottawa', country: 'CA' }, speakers: [{ name: 'Ada', twitter: '@ada' }, 'Bob'] },
    { photo: { src: 'a.jpg', alt: 'A' }, extra: { anything: { at: 'all' } }, tags: ['a'], color: 'red' },
    { address: 'Ottawa', speakers: { name: 'Ada' } },
  ],
  page: [
    { title: 'Home', links: [{ href: '/' }] },
    { title: 'Home', links: [{ href: '/', label: 'Home' }], footer: true },
  ],
  course: [
    { identity: { title: 'Rust' }, pricing: { amount: 40 } },
    { identity: { title: 'Rust', level: 'easy' }, color: 'red' },
    { identity: { title: 'Rust' }, modules: [{ title: 'Basics', room: 'A', lessons: [{ title: 'Install', video: 'x' }] }] },
    { identity: { title: 'Rust' }, more: { faq: [{ q: 'Why?', children: [{ q: 'How?', a: 'So' }] }], glossary: {} } },
    // The retired flat form: `title` and `amount` belong under their sections; `color` nowhere.
    { title: 'Rust', amount: 40, color: 'red' },
    // A field only a list's records declare, written at the top.
    { identity: { title: 'Rust' }, minutes: 30 },
    { identity: 'Rust', modules: { title: 'Basics' } },
  ],
}

// The keys the push refuses as undeclared, and as written in the flat form, read from its refusals.
function pushRefused(refusals) {
  const keys = []
  for (const line of refusals) {
    const undeclared = /: (.+?) (?:is not a field|are not fields) of /.exec(line)
    if (undeclared) keys.push(...[...undeclared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
    const flat = / is written by section, .* — move (.+)\.$/.exec(line)
    if (flat) keys.push(...[...flat[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((k) => !k.endsWith(':')))
  }
  return keys.sort()
}

describe('the check and the push name the same keys a record has no place for', () => {
  for (const [name, authored] of Object.entries(SCHEMAS)) {
    const normalized = validateAndNormalizeSchema(authored, `@/${name}`)
    const declaration = toDataSchemaDeclaration(normalized, { name: `@acme/${name}` })
    RECORDS[name].forEach((record, i) => {
      it(`${name} #${i}`, () => {
        const { refusals } = recordsToEntities({ label: name, records: [{ slug: `r${i}`, ...record }], declaration })
        const checked = [
          ...undeclaredFields(normalized, record).map((u) => u.path),
          ...misplacedFields(normalized, record).map((m) => m.key),
        ].sort()
        expect(checked).toEqual(pushRefused(refusals))
      })
    })
  }

  it('finds something in the records written to have it', () => {
    const found = Object.entries(SCHEMAS).flatMap(([name, authored]) => {
      const normalized = validateAndNormalizeSchema(authored, `@/${name}`)
      return RECORDS[name].flatMap((record) => undeclaredFields(normalized, record).map((u) => `${name}:${u.path}`))
    })
    expect(found).toEqual([
      'quote:order',
      'quote:logo',
      'venue:address.country',
      'venue:speakers[0].twitter',
      'venue:color',
      'page:links[0].label',
      'page:footer',
      'course:identity.level',
      'course:color',
      'course:modules[0].room',
      'course:modules[0].lessons[0].video',
      'course:more.faq[0].children[0].a',
      'course:more.glossary',
      'course:color',
      'course:minutes',
    ])
  })
})
