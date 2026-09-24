import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitEntityPackage,
  emitRecordSyncPackage,
  buildRecordEntities,
  readZip,
  mintUuidV7,
  recordsToEntities,
  entityContentHash,
} from '../src/uwx/index.js'
import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { computeHash } from '../src/i18n/hash.js'

// Drive the mapper off a REAL declaration (author → normalize → lower), so the
// schema lowering and the mapper stay in step.
const lower = (authored, ref, name) =>
  toDataSchemaDeclaration(validateAndNormalizeSchema(authored, ref), { name })

const unzip = (buf) => {
  const files = readZip(buf)
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  // old `items[]` lane (emitEntityPackage): files are entities/<uuid>.json
  const entity = (uuid) =>
    JSON.parse(files.get(`entities/${uuid}.json`).toString('utf8'))
  // sync lane: files are at an opaque path recorded in entries[].file
  const byFile = (path) => JSON.parse(files.get(path).toString('utf8'))
  return { files, manifest, entity, byFile }
}

// ── Step A: model-by-name in emitEntityPackage (legacy items[] lane) ─────────

describe('emitEntityPackage — model-by-name', () => {
  it('serializes an entity by NAME (no model_uuid) + null-uuid models_required', () => {
    const uuid = mintUuidV7()
    const buf = emitEntityPackage({
      entities: [
        {
          uuid,
          model: '@acme/product',
          items: [{ uuid: mintUuidV7(), section: 'product', data: { sku: 'X' } }],
        },
      ],
      modelsRequired: [{ name_at_export: '@acme/product' }],
    })
    const { manifest, entity } = unzip(buf)

    // models_required: uuid is null; the importer resolves by name.
    expect(manifest.models_required[0]).toEqual({
      uuid: null,
      name_at_export: '@acme/product',
      policy_hint: 'validate_existing',
    })
    // the per-entity file carries `model` (name) and NO model_uuid.
    const e = entity(uuid)
    expect(e.model).toBe('@acme/product')
    expect(e).not.toHaveProperty('model_uuid')
    // the manifest entry mirrors the by-name pointer.
    const entry = manifest.entries.find((x) => x.uuid === uuid)
    expect(entry.model).toBe('@acme/product')
    expect(entry).not.toHaveProperty('model_uuid')
  })

  it('keeps a by-uuid entity unchanged (model_uuid, no `model`)', () => {
    const uuid = mintUuidV7()
    const modelUuid = mintUuidV7()
    const buf = emitEntityPackage({
      entities: [{ uuid, model_uuid: modelUuid, items: [] }],
      modelsRequired: [{ uuid: modelUuid, name_at_export: '@uniweb/site-content' }],
    })
    const { manifest, entity } = unzip(buf)
    const e = entity(uuid)
    expect(e.model_uuid).toBe(modelUuid)
    expect(e).not.toHaveProperty('model')
    expect(manifest.models_required[0].uuid).toBe(modelUuid)
  })

  it('rejects an entity with neither model_uuid nor model', () => {
    expect(() =>
      emitEntityPackage({
        entities: [{ uuid: mintUuidV7(), items: [] }],
        modelsRequired: [{ name_at_export: '@acme/x' }],
      })
    ).toThrow(/needs a model_uuid or a model/)
  })
})

// ── Step B: recordsToEntities → `$`-document (pure mapper) ──────────

describe('recordsToEntities — flat record → brief section `$`-document', () => {
  const declaration = lower(
    {
      name: 'product',
      sortDate: 'published',
      fields: {
        title: { type: 'string', required: true }, // human text → localized
        price: { type: 'decimal' },
        published: { type: 'date' },
        sku: { type: 'string', translatable: false }, // machine → not localized
      },
    },
    '@/product',
    '@acme/product'
  )

  it('lowers to a single section named `brief`, marked brief — never the short name', () => {
    expect(Object.keys(declaration.sections)).toEqual(['brief'])
    expect(declaration.sections.brief.brief).toBe(true)
  })

  it('maps each record to one by-name entity-content document (no $uuid on first sync)', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [
        { slug: 'widget-x', title: 'Widget X', price: 9.99, published: '2026-01-01', sku: 'WX-1' },
      ],
      declaration,
    })
    expect(entities).toHaveLength(1)
    const [e] = entities
    expect(e.model).toBe('@acme/product')
    expect(e.id).toBe('products/widget-x') // path-style payload-local handle
    expect(e.slug).toBe('widget-x')
    // ⛔ No `collection` field. The folder used to be DERIVED by grouping entities
    // on it; it is authored in records/folder.yml now, so nothing groups and nothing reads it.
    expect(e).not.toHaveProperty('collection')
    expect(e.uuid).toBeNull() // first sync — backend mints
    expect(e.file).toBe('entities/products/widget-x.json')
    expect(e.document).not.toHaveProperty('items') // not the legacy items[] shape
    expect(e.document.$id).toBe('products/widget-x')
    expect(e.document.$schema).toBe('@acme/product')
    expect(e.document).not.toHaveProperty('$uuid')
    // brief section keyed by its name; its value is the fields object.
    expect(e.document.brief).toMatchObject({ price: 9.99, published: '2026-01-01' })
  })

  it('wraps a localized scalar field per-locale from translations (B)', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'a', title: 'Hello' }],
      declaration,
      translations: { es: { [computeHash('Hello')]: 'Hola' } },
    })
    // localized scalar → { source, ...targets }; a non-localized (machine) field is untouched.
    expect(entities[0].document.brief.title).toEqual({ en: 'Hello', es: 'Hola' })
  })

  it('without translations a localized scalar stays source-only (backward compatible)', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'a', title: 'Hello' }],
      declaration,
    })
    expect(entities[0].document.brief.title).toEqual({ en: 'Hello' })
  })

  it('canonical key order: $id, $schema, then the section (no leading $uuid first sync)', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'a', title: 'A' }],
      declaration,
    })
    expect(Object.keys(entities[0].document)).toEqual(['$id', '$schema', 'brief'])
    // ⚠️ The caller supplies `$id` now — it is the entity's POOL id, and only the
    // caller knows the pool position. This unit exercises the mapper alone, so it
    // falls back to `<queryName>/<slug>`; the real producer always sets it.
    expect(entities[0].document.$id).toBe('products/a')
  })

  it('emits the brief fields in schema-declared order', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'a', sku: 'S', published: '2026-01-01', price: 1, title: 'A' }],
      declaration,
    })
    // declared order is title, price, published, sku — not the record's order.
    expect(Object.keys(entities[0].document.brief)).toEqual([
      'title',
      'price',
      'published',
      'sku',
    ])
  })

  it('wraps localized fields, leaves scalars/dates raw, drops slug', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [
        { slug: 'widget-x', title: 'Widget X', price: 9.99, published: '2026-01-01', sku: 'WX-1' },
      ],
      declaration,
      sourceLocale: 'en',
    })
    const data = entities[0].document.brief
    expect(data.title).toEqual({ en: 'Widget X' }) // localized wrap
    expect(data.price).toBe(9.99) // raw scalar
    expect(data.published).toBe('2026-01-01') // date string passthrough
    expect(data.sku).toBe('WX-1') // not localized (translatable:false)
    expect(data).not.toHaveProperty('slug') // identity, not data
  })

  it('emits a `date` field as YYYY-MM-DD (not full ISO — backend rejects the latter)', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'd', title: 'D', published: new Date('2026-03-01T00:00:00Z') }],
      declaration, // `published` is type `date`
    })
    expect(entities[0].document.brief.published).toBe('2026-03-01')
  })

  it('emits a `datetime` field as full RFC3339', () => {
    const dt = lower(
      { name: 'event', fields: { title: { type: 'string' }, at: { type: 'datetime' } } },
      '@/event',
      '@acme/event'
    )
    const { entities } = recordsToEntities({
      label: 'events',
      records: [{ slug: 'e', title: 'E', at: new Date('2026-03-01T12:30:00Z') }],
      declaration: dt,
    })
    expect(entities[0].document.brief.at).toBe('2026-03-01T12:30:00.000Z')
  })

  it('round-trips a back-filled $uuid for re-sync (as the leading key)', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'widget-x', $uuid: 'abc-123', title: 'Widget X' }],
      declaration,
    })
    const [e] = entities
    expect(e.uuid).toBe('abc-123')
    expect(e.document.$uuid).toBe('abc-123')
    expect(Object.keys(e.document)).toEqual(['$uuid', '$id', '$schema', 'brief'])
  })

  it('honors an explicit $id over the slug', () => {
    const { entities } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'file-name', $id: 'explicit-id', title: 'X' }],
      declaration,
    })
    expect(entities[0].id).toBe('explicit-id')
    expect(entities[0].document.$id).toBe('explicit-id')
    // file path still uses the slug (the on-disk anchor).
    expect(entities[0].file).toBe('entities/products/file-name.json')
  })

  // ⛔ A key the Model does not declare is lost twice — the backend never gets it and
  // the next pull writes the file without it — so the push refuses it rather than
  // warning "not synced" (until 2026-09-24).
  it('refuses a record carrying a field not on the Model, and never sends the field', () => {
    const { entities, refusals } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'g', title: 'G', color: 'red', size: 'L' }],
      declaration,
    })
    expect(entities[0].document.brief).not.toHaveProperty('color')
    expect(refusals).toEqual([
      'products/g: "color" and "size" are not fields of @acme/product — a push cannot carry ' +
        'them, and the next pull would drop them from the file. Declare them in the schema, or ' +
        'remove them.',
    ])
  })

  it('skips a record without a slug (with a warning)', () => {
    const { entities, warnings } = recordsToEntities({
      label: 'products',
      records: [{ title: 'No slug' }],
      declaration,
    })
    expect(entities).toHaveLength(0)
    expect(warnings.some((w) => w.includes('without a slug'))).toBe(true)
  })

  it('a Model whose root is a list is written by section and sent — it has no brief', () => {
    const declNoBrief = lower(
      { name: 'log', sections: { entries: { kind: 'multi', fields: { msg: { type: 'string' } } } } },
      '@/log',
      '@acme/log'
    )
    expect(Object.values(declNoBrief.sections).some((s) => s.brief)).toBe(false)
    const { entities, refusals } = recordsToEntities({
      label: 'logs',
      records: [{ slug: 'a', entries: [{ msg: 'hi' }, { msg: 'there' }] }],
      declaration: declNoBrief,
    })
    expect(refusals).toEqual([])
    expect(entities[0].document).toEqual({
      $id: 'logs/a',
      $schema: '@acme/log',
      entries: [{ msg: { en: 'hi' } }, { msg: { en: 'there' } }],
    })
    // …and its fields are not written flat: a list has no flat form.
    expect(
      recordsToEntities({ label: 'logs', records: [{ slug: 'b', msg: 'hi' }], declaration: declNoBrief }).refusals
    ).toEqual([
      'logs/b: @acme/log is written by section, each section under its own name ("entries") — ' +
        'move "msg" into a record of "entries:".',
    ])
  })
})

// ── A multi-section record is written by section; what cannot be sent is refused ──

describe('recordsToEntities — a multi-section record is written by section', () => {
  // ⭐ A schema with more than one section is written by section — each under its own
  // name, the stored entity's shape — and the retired flat form is refused, naming where
  // each field belongs [Diego, 2026-09-22]. Measured before: a pull wrote such a record
  // back from its brief alone, so everything else was lost from the author's file.
  const event = lower(
    {
      name: 'event',
      sections: {
        details: {
          brief: true,
          fields: { title: { type: 'string', required: true }, location: { type: 'string' } },
        },
        extra: {
          fields: { note: { type: 'string' }, contact: { type: 'string', required: true } },
        },
        sessions: { many: true, fields: { title: { type: 'string', required: true } } },
      },
    },
    '@/event',
    '@acme/event'
  )
  const map = (record) =>
    recordsToEntities({ label: 'event', records: [{ slug: 'launch', ...record }], declaration: event })

  it('a record written by section is sent, every section it holds included — a list as its records', () => {
    const { refusals, entities } = map({
      details: { title: 'Launch', location: 'Toronto' },
      sessions: [{ title: 'Keynote' }, { title: 'Workshop' }],
    })
    expect(refusals).toEqual([])
    expect(entities[0].document).toEqual({
      $id: 'event/launch',
      $schema: '@acme/event',
      details: { title: { en: 'Launch' }, location: { en: 'Toronto' } },
      sessions: [{ title: { en: 'Keynote' } }, { title: { en: 'Workshop' } }],
    })
  })

  it('⛔ the flat form is refused, naming the section each field belongs under', () => {
    const { refusals } = map({ location: 'Toronto', note: 'Bring a badge' })
    expect(refusals).toEqual([
      'event/launch: @acme/event is written by section, each section under its own name ' +
        '("details", "extra" and "sessions") — move "location" under "details:" and "note" under "extra:".',
    ])
  })

  it('a field two single sections declare is named with both — sections are namespaces', () => {
    const both = lower(
      {
        name: 'pair',
        sections: {
          a: { brief: true, fields: { title: { type: 'string' } } },
          b: { fields: { title: { type: 'string' } } },
        },
      },
      '@/pair',
      '@acme/pair'
    )
    const { refusals } = recordsToEntities({ label: 'pair', records: [{ slug: 'x', title: 'T' }], declaration: both })
    expect(refusals).toEqual([
      'pair/x: @acme/pair is written by section, each section under its own name ("a" and "b") — ' +
        'move "title" under "a:" or "b:".',
    ])
    // Written by section, the two fields hold two values.
    const ok = recordsToEntities({
      label: 'pair',
      records: [{ slug: 'y', a: { title: 'A' }, b: { title: 'B' } }],
      declaration: both,
    })
    expect(ok.refusals).toEqual([])
    expect(ok.entities[0].document.a).toEqual({ title: { en: 'A' } })
    expect(ok.entities[0].document.b).toEqual({ title: { en: 'B' } })
  })

  it('⛔ a record missing a required field of the brief is refused, by its path in the file', () => {
    expect(map({ details: { location: 'Toronto' } }).refusals).toEqual([
      'event/launch: @acme/event requires "details.title", and this record has no value for it.',
    ])
  })

  it('the brief is always sent — an absent one is empty, and its required field is refused', () => {
    expect(map({ extra: { note: 'n', contact: 'c' } }).refusals).toEqual([
      'event/launch: @acme/event requires "details.title", and this record has no value for it.',
    ])
  })

  it('an empty value is no value — a field written with nothing after it reads as null', () => {
    expect(map({ details: { title: null } }).refusals).toHaveLength(1)
  })

  it("another single section's required field counts only once the record fills that section", () => {
    // `extra` left out is not sent, so its `contact` cannot fail the send…
    expect(map({ details: { title: 'Launch' } }).refusals).toEqual([])
    // …but a record that fills it sends it, and then it needs its required field.
    expect(map({ details: { title: 'Launch' }, extra: { note: 'Bring a badge' } }).refusals).toEqual([
      'event/launch: @acme/event requires "extra.contact", and this record has no value for it.',
    ])
  })

  it("a list's records are checked for their required fields too, each by its index", () => {
    expect(map({ details: { title: 'Launch' }, sessions: [{ title: 'Keynote' }, {}] }).refusals).toEqual([
      'event/launch: @acme/event requires "sessions[1].title", and this record has no value for it.',
    ])
  })

  it('⛔ a value of the wrong shape for its section is refused, saying which shape it takes', () => {
    expect(map({ details: { title: 'Launch' }, sessions: { title: 'Keynote' } }).refusals).toEqual([
      'event/launch: "sessions" holds a list of records — write it as a list ("- …" under "sessions:").',
    ])
    expect(map({ details: 'Launch' }).refusals).toEqual([
      'event/launch: "details" is a section — write its fields under it ("details:" then each field indented).',
    ])
  })

  it('a key a section does not declare is refused by its path in the file', () => {
    expect(map({ details: { title: 'Launch', color: 'red' } }).refusals).toEqual([
      'event/launch: "details.color" is not a field of @acme/event — a push cannot carry it, and ' +
        'the next pull would drop it from the file. Declare it in the schema, or remove it.',
    ])
  })
})

describe('recordsToEntities — nested sections and self-nesting lists', () => {
  const course = lower(
    {
      name: 'course',
      sections: {
        identity: { brief: true, fields: { title: { type: 'string' } } },
        outline: {
          many: true,
          tree: true,
          fields: {
            heading: { type: 'string' },
            links: { type: 'object', many: true, fields: { href: { type: 'string', translatable: false } } },
          },
        },
      },
    },
    '@/course',
    '@acme/course'
  )

  it('a self-nesting list nests under `children:` in the file and `$children` on the wire', () => {
    const { refusals, entities } = recordsToEntities({
      label: 'course',
      records: [
        {
          slug: 'rust',
          identity: { title: 'Rust' },
          outline: [{ heading: 'Basics', links: [{ href: '/a' }], children: [{ heading: 'Install' }] }],
        },
      ],
      declaration: course,
    })
    expect(refusals).toEqual([])
    expect(entities[0].document.outline).toEqual([
      { heading: { en: 'Basics' }, links: [{ href: '/a' }], $children: [{ heading: { en: 'Install' } }] },
    ])
  })

  it('a localized field inside a nested section is wrapped per locale, like any other', () => {
    const post = lower(
      {
        name: 'post',
        sections: {
          card: { brief: true, fields: { title: { type: 'string' } } },
          body: {
            fields: { seo: { type: 'object', fields: { title: { type: 'string' }, noindex: { type: 'boolean' } } } },
          },
        },
      },
      '@/post',
      '@acme/post'
    )
    const { entities } = recordsToEntities({
      label: 'post',
      records: [{ slug: 'p', card: { title: 'P' }, body: { seo: { title: 'SEO', noindex: true } } }],
      declaration: post,
    })
    expect(entities[0].document.body).toEqual({ seo: { title: { en: 'SEO' }, noindex: true } })
  })

  it('a list of localized values goes up as one locale map per element', () => {
    const tagged = lower(
      { name: 'tagged', fields: { title: { type: 'string' }, labels: { type: 'string', many: true } } },
      '@/tagged',
      '@acme/tagged'
    )
    const { entities } = recordsToEntities({
      label: 'tagged',
      records: [{ slug: 't', title: 'T', labels: ['one', 'two'] }],
      declaration: tagged,
    })
    expect(entities[0].document.brief).toEqual({
      title: { en: 'T' },
      labels: [{ en: 'one' }, { en: 'two' }],
    })
  })
})

// ── Step B2: markdown body → the brief's content body field ──────────────────

describe('recordsToEntities — markdown body → content body field', () => {
  const decl = lower(
    { name: 'article', fields: { title: { type: 'string' }, body: { type: 'markdown' } } },
    '@/article',
    '@acme/article'
  )

  it('maps $body to the brief content field as the raw value (localized-wrapped, not ProseMirror)', () => {
    const { entities, warnings } = recordsToEntities({
      label: 'articles',
      records: [{ slug: 'hello', title: 'Hello', $body: '\n# Welcome\n' }],
      declaration: decl,
      sourceLocale: 'en',
    })
    expect(warnings).toEqual([])
    const data = entities[0].document.brief
    expect(data.title).toEqual({ en: 'Hello' })
    expect(data.body).toEqual({ en: '\n# Welcome\n' }) // raw markdown string
  })

  it('lets an explicit frontmatter value win over the body', () => {
    const { entities } = recordsToEntities({
      label: 'articles',
      records: [{ slug: 'h', title: 'H', body: 'explicit', $body: 'from-md-body' }],
      declaration: decl,
    })
    expect(entities[0].document.brief.body).toEqual({ en: 'explicit' })
  })

  it('never treats $body as an unknown field', () => {
    const { warnings } = recordsToEntities({
      label: 'articles',
      records: [{ slug: 'hello', title: 'Hello', $body: 'x' }],
      declaration: decl,
    })
    expect(warnings.some((w) => w.includes('$body'))).toBe(false)
  })

  it('refuses a markdown body the Model has no field for', () => {
    const noRich = lower(
      { name: 'product', fields: { title: { type: 'string' } } },
      '@/product',
      '@acme/product'
    )
    const { refusals } = recordsToEntities({
      label: 'products',
      records: [{ slug: 'p', title: 'P', $body: 'orphan body' }],
      declaration: noRich,
    })
    expect(refusals).toEqual([expect.stringMatching(/^products\/p: the file has a markdown body, and @acme\/product has no field for it/)])
  })
})

describe('recordsToEntities — markdown body → prosemirror content field (B)', () => {
  // The declaration form a `format: prosemirror` constraint lowers to. Hand-built —
  // the producer consumes the declaration, independent of the authoring sugar.
  const decl = {
    name: '@acme/article',
    sections: {
      article: {
        brief: true,
        fields: {
          title: { type: 'string', localized: true },
          body: { type: 'json', format: 'prosemirror', localized: true },
        },
      },
    },
  }

  it('converts the markdown body to a ProseMirror doc on the wire (not the raw string)', () => {
    const { entities, warnings } = recordsToEntities({
      label: 'articles',
      records: [{ slug: 'hello', title: 'Hello', $body: 'Hello world\n' }],
      declaration: decl,
    })
    expect(warnings).toEqual([])
    const body = entities[0].document.article.body
    // A localized field always rides as a `{ lang: value }` map on the wire (the
    // projector drops a non-map localized value), so the converted doc is under `en`.
    expect(body.en.type).toBe('doc') // ProseMirror, converted from markdown (not the raw string)
    expect(JSON.stringify(body)).toContain('Hello world')
  })

  it('wraps per-locale as a self-contained doc (resolved from translations)', () => {
    const { entities } = recordsToEntities({
      label: 'articles',
      records: [{ slug: 'hello', title: 'Hello', $body: 'Hello world\n' }],
      declaration: decl,
      translations: { es: { [computeHash('Hello world')]: 'Hola mundo' } },
    })
    const body = entities[0].document.article.body
    expect(body.en.type).toBe('doc') // source doc
    // es is a self-contained per-locale DOC, not a {src:tgt} map — dynamic delivery
    // ships content[locale] verbatim and cannot resolve a map. (Same as a section.)
    expect(body.es.type).toBe('doc')
    expect(JSON.stringify(body.es)).toContain('Hola mundo')
    expect(JSON.stringify(body.es)).not.toContain('Hello world')
  })
})

// ── Step C: emitRecordSyncPackage (orchestrator, real fs) ────────────────

describe('emitRecordSyncPackage — site + local foundation → .uwx', () => {
  let root
  let siteDir

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-sync-'))
    siteDir = join(root, 'site')
    const foundationDir = join(root, 'foundation')
    mkdirSync(join(siteDir, 'records', 'acme', 'product'), { recursive: true })
    mkdirSync(join(foundationDir, 'dist', 'meta'), { recursive: true })

    // Site: a file collection mapped to a registry Model by name.
    writeFileSync(
      join(siteDir, 'site.yml'),
      [
        'name: Test Site',
        'foundation: "@acme/marketing"',
        'queries:',
        '  products:',
        '    model: "@acme/product"',
        '',
      ].join('\n')
    )
    writeFileSync(
      join(siteDir, 'package.json'),
      // Keyed by the DECLARED foundation name, which is the shape a real project has
      // (model doc, correction #11): site.yml names `@acme/marketing`, so that is the
      // dependency key. The old fixture keyed it `foundation`, matching a resolver
      // that read `dependencies.foundation` — a key no template produces.
      JSON.stringify({ name: 'site', dependencies: { '@acme/marketing': 'file:../foundation' } })
    )
    writeFileSync(join(siteDir, 'records', 'acme', 'product', 'widget-x.yml'), 'title: Widget X\nprice: 9.99\n')
    writeFileSync(join(siteDir, 'records', 'acme', 'product', 'gadget-y.yml'), 'title: Gadget Y\nprice: 19.5\n')

    // Foundation: a built schema.json defining the @acme/product data-schema.
    const schema = {
      _self: { name: '@acme/marketing', version: '1.0.0', role: 'foundation' },
      dataSchemas: {
        '@/product': validateAndNormalizeSchema(
          { name: 'product', fields: { title: { type: 'string' }, price: { type: 'decimal' } } },
          '@/product'
        ),
      },
    }
    writeFileSync(join(foundationDir, 'dist', 'meta', 'schema.json'), JSON.stringify(schema))
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('emits one by-name `$`-document per record, all of the mapped Model', async () => {
    const { buffer, models, entityCount } = await emitRecordSyncPackage(siteDir, {
      exportedAt: '2026-05-27T00:00:00Z',
    })
    expect(models).toEqual(['@acme/product'])
    expect(entityCount).toBe(2)

    const { manifest, byFile } = unzip(buffer)
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required).toEqual([
      { uuid: null, name_at_export: '@acme/product', policy_hint: 'validate_existing' },
    ])
    // sync lane: self-owned, so roots is empty (every node is writable).
    expect(manifest.roots).toEqual([])
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    const entityEntries = manifest.entries.filter((e) => e.kind === 'entity')
    expect(entityEntries).toHaveLength(2)
    for (const entry of entityEntries) {
      // entry.uuid is the `$id` handle label (v1); model is by name.
      expect(entry.model).toBe('@acme/product')
      expect(entry).not.toHaveProperty('model_uuid')
      // Named for the schema folder the records came from — a query no longer
      // decides which records sync, so it no longer names them in the package.
      expect(entry.file).toMatch(/^entities\/acme\/product\/.+\.json$/)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)

      const doc = byFile(entry.file)
      expect(doc.$schema).toBe('@acme/product')
      expect(doc.$id).toBe(entry.uuid) // entry.uuid mirrors the body's $id
      expect(doc).not.toHaveProperty('$uuid') // first sync — backend mints
      expect(doc).not.toHaveProperty('items')
      // human-text `title` lowers to localized → wrapped `{ en: ... }`; `price` raw.
      expect(doc.brief.title).toHaveProperty('en')
      expect(typeof doc.brief.price).toBe('number')
    }
  })

  it('a record keeps its own id; the wire carries only what each backend minted', async () => {
    // A second site whose record already carries a $uuid (a prior back-fill).
    const reSite = join(root, 'resync-site')
    mkdirSync(join(reSite, 'records', 'acme', 'product'), { recursive: true })
    writeFileSync(
      join(reSite, 'site.yml'),
      'name: Re\nfoundation: "@acme/marketing"\nqueries:\n  products:\n    model: \"@acme/product\"\n'
    )
    writeFileSync(
      join(reSite, 'package.json'),
      JSON.stringify({ name: 're', dependencies: { '@acme/marketing': 'file:../foundation' } })
    )
    writeFileSync(
      join(reSite, 'records', 'acme', 'product', 'widget-x.yml'),
      '"$uuid": existing-uuid-1\ntitle: Widget X\n'
    )

    // ⭐ The file's `$uuid` is the record's OWN id. What reaches the wire is the uuid
    // THIS backend minted for it, from sync.json — here the first backend, so the map
    // is identity, exactly as a single-backend project always behaved.
    const A = 'http://backend-a.test'
    writeFileSync(
      join(reSite, 'sync.json'),
      JSON.stringify({ version: 1, backends: { [A]: { records: { 'existing-uuid-1': 'existing-uuid-1' } } } })
    )
    const emit = async (backend) => {
      const { buffer } = await emitRecordSyncPackage(reSite, backend ? { backend } : {})
      const { manifest, byFile } = unzip(buffer)
      return byFile(manifest.entries.find((e) => e.kind === 'entity').file)
    }

    const doc = await emit(A)
    expect(doc.$uuid).toBe('existing-uuid-1')
    expect(Object.keys(doc)).toEqual(['$uuid', '$id', '$schema', 'brief'])

    // ⭐ A backend that minted something ELSE for it gets its own uuid, not ours.
    writeFileSync(
      join(reSite, 'sync.json'),
      JSON.stringify({
        version: 1,
        backends: {
          [A]: { records: { 'existing-uuid-1': 'existing-uuid-1' } },
          'http://backend-b.test': { records: { 'existing-uuid-1': 'uuid-minted-by-b' } }
        }
      })
    )
    expect((await emit('http://backend-b.test')).$uuid).toBe('uuid-minted-by-b')

    // ⛔ And a backend that never minted one gets NONE — never a uuid it did not
    // mint. Whether it would accept one is the backend's to say; this is correct
    // either way, and it is what stops one backend's ids reaching another.
    expect((await emit('http://backend-c.test')).$uuid).toBeUndefined()
    // No backend named is the same answer.
    expect((await emit(null)).$uuid).toBeUndefined()
  })

  it('errors when no records are syncable (convention schema unresolved, soft-skipped)', async () => {
    // `posts` has no explicit schema; the subfolder-name convention defaults it to
    // `@/post`, which doesn't resolve (no foundation) → soft-skipped → no records.
    const bare = join(root, 'bare')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'site.yml'), 'name: Bare\nqueries:\n  posts: {}\n')
    await expect(emitRecordSyncPackage(bare)).rejects.toThrow(/no records to export/)
  })
})

// ── B3: non-local Model resolution via the injected resolveModel ─────────────

describe('emitRecordSyncPackage — non-local Model via resolveModel', () => {
  let root
  let siteDir

  const productDecl = {
    name: '@std/product',
    sections: {
      product: {
        brief: true,
        fields: {
          title: { type: 'string', localized: true },
          price: { type: 'decimal' },
        },
      },
    },
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-b3-'))
    siteDir = join(root, 'site')
    mkdirSync(join(siteDir, 'records', 'std', 'product'), { recursive: true })
    // NO foundation dependency — the Model is non-local (e.g. a @std schema).
    writeFileSync(
      join(siteDir, 'site.yml'),
      'name: T\nqueries:\n  products:\n    model: \"@std/product\"\n'
    )
    writeFileSync(join(siteDir, 'records', 'std', 'product', 'a.yml'), 'title: A\nprice: 5\n')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('fetches the declaration for a Model not in any local foundation', async () => {
    const calls = []
    const resolveModel = async (name) => {
      calls.push(name)
      return name === '@std/product' ? productDecl : null
    }
    const { buffer, models, entityCount } = await emitRecordSyncPackage(siteDir, { resolveModel })
    expect(calls).toEqual(['@std/product'])
    expect(models).toEqual(['@std/product'])
    expect(entityCount).toBe(1)
    const { manifest, byFile } = unzip(buffer)
    const doc = byFile(manifest.entries[0].file)
    expect(doc.$schema).toBe('@std/product')
    expect(doc.product.title).toEqual({ en: 'A' }) // declaration drove the localized wrap
    expect(doc.product.price).toBe(5)
  })

  it('errors clearly when the resolver returns null (Model not registered)', async () => {
    await expect(emitRecordSyncPackage(siteDir, { resolveModel: async () => null })).rejects.toThrow(
      /register it first/
    )
  })

  it('prefers a local foundation when it defines the Model (resolver untouched)', async () => {
    const localSite = join(root, 'local')
    const foundationDir = join(root, 'local-foundation')
    mkdirSync(join(localSite, 'records', 'acme', 'product'), { recursive: true })
    mkdirSync(join(foundationDir, 'dist', 'meta'), { recursive: true })
    writeFileSync(
      join(localSite, 'site.yml'),
      'name: L\nfoundation: "@acme/marketing"\nqueries:\n  products:\n    model: \"@acme/product\"\n'
    )
    writeFileSync(
      join(localSite, 'package.json'),
      JSON.stringify({ name: 'l', dependencies: { '@acme/marketing': 'file:../local-foundation' } })
    )
    writeFileSync(join(localSite, 'records', 'acme', 'product', 'a.yml'), 'title: A\n')
    writeFileSync(
      join(foundationDir, 'dist', 'meta', 'schema.json'),
      JSON.stringify({
        _self: { name: '@acme/marketing', version: '1.0.0', role: 'foundation' },
        dataSchemas: {
          '@/product': validateAndNormalizeSchema({ name: 'product', fields: { title: { type: 'string' } } }, '@/product'),
        },
      })
    )

    let called = false
    const resolveModel = async () => {
      called = true
      throw new Error('resolver should not be called when the Model is local')
    }
    const { models } = await emitRecordSyncPackage(localSite, { resolveModel })
    expect(models).toEqual(['@acme/product'])
    expect(called).toBe(false)
  })
})

// ── B4: send only changed (content-hash cache) ──────────────────────────────

describe('entityContentHash', () => {
  it('is identity-independent — stable across a back-filled $uuid', () => {
    const first = entityContentHash({ $id: 'x', $schema: '@a/m', m: { title: { en: 'Hi' } } })
    const resync = entityContentHash({
      $uuid: 'minted',
      $id: 'x',
      $schema: '@a/m',
      m: { $uuid: 'rec', title: { en: 'Hi' } },
    })
    expect(first).toBe(resync)
  })
  it('changes when field content changes', () => {
    const a = entityContentHash({ $id: 'x', $schema: '@a/m', m: { title: { en: 'Hi' } } })
    const b = entityContentHash({ $id: 'x', $schema: '@a/m', m: { title: { en: 'Bye' } } })
    expect(a).not.toBe(b)
  })
})

describe('emitRecordSyncPackage — send only changed', () => {
  let root
  let siteDir

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-b4-'))
    siteDir = join(root, 'site')
    const fdn = join(root, 'foundation')
    mkdirSync(join(siteDir, 'records', 'acme', 'product'), { recursive: true })
    mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
    writeFileSync(
      join(siteDir, 'site.yml'),
      'name: T\nfoundation: "@acme/marketing"\nqueries:\n  products:\n    model: \"@acme/product\"\n'
    )
    writeFileSync(
      join(siteDir, 'package.json'),
      JSON.stringify({ name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } })
    )
    writeFileSync(join(siteDir, 'records', 'acme', 'product', 'a.yml'), 'title: A\nprice: 1\n')
    writeFileSync(join(siteDir, 'records', 'acme', 'product', 'b.yml'), 'title: B\nprice: 2\n')
    writeFileSync(
      join(fdn, 'dist', 'meta', 'schema.json'),
      JSON.stringify({
        _self: { name: '@acme/marketing', version: '1.0.0', role: 'foundation' },
        dataSchemas: {
          '@/product': validateAndNormalizeSchema(
            { name: 'product', fields: { title: { type: 'string' }, price: { type: 'decimal' } } },
            '@/product'
          ),
        },
      })
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('first sync sends all + returns the full hash map', async () => {
    const { entityCount, skipped, hashes } = await emitRecordSyncPackage(siteDir)
    expect(entityCount).toBe(2)
    expect(skipped).toBe(0)
    expect(Object.keys(hashes).sort()).toEqual([
      '@acme/product acme/product/a',
      '@acme/product acme/product/b',
    ])
  })

  it('skips records whose content hash matches the prior cache (nothing to send)', async () => {
    const first = await emitRecordSyncPackage(siteDir)
    const { entityCount, skipped, buffer } = await emitRecordSyncPackage(siteDir, {
      priorHashes: first.hashes,
    })
    expect(entityCount).toBe(0)
    expect(skipped).toBe(2)
    expect(buffer).toBeNull()
  })

  it('sends only the changed record after an edit (index correlates to the subset)', async () => {
    const first = await emitRecordSyncPackage(siteDir)
    writeFileSync(join(siteDir, 'records', 'acme', 'product', 'b.yml'), 'title: B2\nprice: 2\n')
    const { entityCount, skipped, index } = await emitRecordSyncPackage(siteDir, {
      priorHashes: first.hashes,
    })
    expect(entityCount).toBe(1)
    expect(skipped).toBe(1)
    expect(index[0].id).toBe('acme/product/b')
  })

  it('sendAll bypasses the cache', async () => {
    const first = await emitRecordSyncPackage(siteDir)
    const { entityCount, skipped } = await emitRecordSyncPackage(siteDir, {
      priorHashes: first.hashes,
      sendAll: true,
    })
    expect(entityCount).toBe(2)
    expect(skipped).toBe(0)
  })
})

// ── B-1: free-form per-locale body override on a prosemirror content field ────

describe('buildRecordEntities — free-form collection body override (B-1)', () => {
  let root
  let siteDir

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-ff-'))
    siteDir = join(root, 'site')
    const foundationDir = join(root, 'foundation')
    mkdirSync(join(siteDir, 'records', 'acme', 'article'), { recursive: true })
    // ⭐ The free-form override lives in the parallel locales/ tree, body-only
    // markdown, MIRRORING THE POOL — keyed by the entity, not by the query that
    // selects it, so two queries over one schema share one translation.
    mkdirSync(join(siteDir, 'locales', 'freeform', 'es', 'records', 'acme', 'article'), { recursive: true })
    mkdirSync(join(foundationDir, 'dist', 'meta'), { recursive: true })

    writeFileSync(
      join(siteDir, 'site.yml'),
      'name: S\nfoundation: "@acme/blog"\nqueries:\n  articles:\n    model: "@acme/article"\n'
    )
    writeFileSync(
      join(siteDir, 'package.json'),
      JSON.stringify({ name: 'site', dependencies: { '@acme/blog': 'file:../foundation' } })
    )
    // Source record: a markdown body that maps to the prosemirror content field.
    writeFileSync(
      join(siteDir, 'records', 'acme', 'article', 'hello.md'),
      '---\ntitle: Hello\n---\nHello world\n'
    )
    // Free-form Spanish body — a full rewrite, not a per-string map.
    writeFileSync(
      join(siteDir, 'locales', 'freeform', 'es', 'records', 'acme', 'article', 'hello.md'),
      'Hola mundo distinto\n'
    )

    // Foundation schema: @/article with a prosemirror content body.
    const schema = {
      _self: { name: '@acme/blog', version: '1.0.0', role: 'foundation' },
      dataSchemas: {
        '@/article': validateAndNormalizeSchema(
          { name: 'article', fields: { title: { type: 'string' }, body: { type: 'json', format: 'prosemirror' } } },
          '@/article'
        ),
      },
    }
    writeFileSync(join(foundationDir, 'dist', 'meta', 'schema.json'), JSON.stringify(schema))
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reads the free-form body as the per-locale value (override wins) even with no structural translations', async () => {
    const { entities } = await buildRecordEntities(siteDir)
    expect(entities).toHaveLength(1)
    const body = entities[0].document.brief.body
    // Wrapped per-locale: source doc + the free-form Spanish doc (not a map).
    expect(body.en.type).toBe('doc')
    expect(JSON.stringify(body.en)).toContain('Hello world')
    expect(body.es.type).toBe('doc')
    expect(JSON.stringify(body.es)).toContain('Hola mundo distinto')
  })
})

// ⛔ `@/x` IS A FOUNDATION-RELATIVE ALIAS AND MUST NOT REACH THE WIRE UNRESOLVED.
//
// Measured on a live manor 2026-08-27: `register` resolved `@/member` into
// `@proximify/member` and stored it; the collections push then named `@/member`
// verbatim, and the backend — which resolves Models BY NAME and never mints —
// refused the restore with "missing host Models for entity restore: @/member".
// One CLI, two paths, one resolver.
//
// ⭐ This pins the PAIR, not the fix: both paths must agree on one alias. The
// register-side rule lives in `uwx/registry-package.js` (`scoped`), this side in
// `buildRecordEntities`, and a test that only asserted one would let them
// drift again.
//
// ⭐ The scope is the FOUNDATION's (2026-09-22) — derived from its name by default,
// which `uwx-query-schema-self-scope.test.js` pins. This fixture's foundation has no
// `main.js`, so nothing names it: these cases state the scope, or have none.
describe('buildRecordEntities — `@/` model refs resolve into the foundation scope', () => {
  let root
  let siteDir

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-selfscope-'))
    siteDir = join(root, 'site')
    const foundationDir = join(root, 'foundation')
    mkdirSync(join(siteDir, 'records', 'member'), { recursive: true })
    mkdirSync(join(foundationDir, 'dist', 'meta'), { recursive: true })

    writeFileSync(
      join(siteDir, 'site.yml'),
      'name: S\nfoundation: "@acme/fnd"\nqueries:\n  members:\n    schema: "@/member"\n'
    )
    writeFileSync(
      join(siteDir, 'package.json'),
      JSON.stringify({ name: 'site', dependencies: { '@acme/fnd': 'file:../foundation' } })
    )
    writeFileSync(
      join(siteDir, 'records', 'member', 'alice.md'),
      '---\nname: Alice\n---\nBio\n'
    )
    writeFileSync(
      join(foundationDir, 'dist', 'meta', 'schema.json'),
      JSON.stringify({
        _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' },
        dataSchemas: {
          '@/member': validateAndNormalizeSchema(
            { name: 'member', fields: { name: { type: 'string' } } },
            '@/member'
          ),
        },
      })
    )
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('resolves `@/member` to `@scope/member` on the entity and leaves `@uniweb/*` alone', async () => {
    const { entities } = await buildRecordEntities(siteDir, { scope: '@acme' })
    expect(entities).toHaveLength(1)
    // The value that becomes `$schema` on the wire, and `models_required` in the manifest.
    expect(entities[0].model).toBe('@acme/member')
    expect(entities[0].document.$schema).toBe('@acme/member')
  })

  it('accepts a bare scope handle as well as `@handle`', async () => {
    const { entities } = await buildRecordEntities(siteDir, { scope: 'acme' })
    expect(entities[0].model).toBe('@acme/member')
  })

  it('⛔ WARNS rather than throwing when the foundation has no scope yet — a `status` probe may meet one', async () => {
    // Throwing here would break `probeUnpushed`, which is offline and must still be
    // able to count changed entities on a site whose foundation never registered.
    const { entities, warnings } = await buildRecordEntities(siteDir)
    expect(entities[0].model).toBe('@/member')
    expect(warnings.join('\n')).toMatch(/foundation-relative/)
    expect(warnings.join('\n')).toMatch(/scope is part of its name/)
  })

  it('⛔ refuses the retired `org` — the site owner is not the foundation scope', async () => {
    await expect(buildRecordEntities(siteDir, { org: '@proximify' })).rejects.toThrow(
      /`org` is no longer read/
    )
  })

  it('⛔ CONTROL — an ALREADY-QUALIFIED ref is NOT re-scoped', async () => {
    // Without this the suite cannot tell "resolves @/" from "rewrites every ref to
    // the scope", and the second would silently re-home a shared or other-org Model.
    const alt = join(root, 'site2')
    mkdirSync(join(alt, 'records', 'acme', 'member'), { recursive: true })
    writeFileSync(
      join(alt, 'site.yml'),
      'name: S2\nfoundation: "@acme/fnd"\nqueries:\n  members:\n    schema: "@acme/member"\n'
    )
    writeFileSync(
      join(alt, 'package.json'),
      JSON.stringify({ name: 'site2', dependencies: { '@acme/fnd': 'file:../foundation' } })
    )
    writeFileSync(join(alt, 'records', 'acme', 'member', 'alice.md'), '---\nname: Alice\n---\nBio\n')

    const { entities } = await buildRecordEntities(alt, { scope: '@proximify' })
    expect(entities[0].model).toBe('@acme/member')
  })
})
