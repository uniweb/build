import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

// Drive the lowering off the real normalized IR, so the translation and the
// normalizer stay in step. Each test authors a schema, normalizes it, lowers it to
// the @uniweb/data-schema `sections:`-tree declaration, and asserts that shape: a
// root MAP of sections; within a section a `fields:` MAP of leaves + nested
// (`type: section`) fields; cardinality via `multiple:`; brief + sort axis inline;
// `enum`/`format` on the field; no `kind`, no schema-level `brief:`/`sort_date_field`.
const lower = (authored, ref, name) =>
  toDataSchemaDeclaration(validateAndNormalizeSchema(authored, ref), { name })

// The name of the brief section (the one marked `brief: true`), or undefined.
const briefName = (decl) =>
  Object.entries(decl.sections || {}).find(([, s]) => s.brief)?.[0]

describe('toDataSchemaDeclaration — fields-form (flat shorthand)', () => {
  const decl = lower(
    {
      name: 'article',
      description: 'A post',
      sortDate: 'published',
      fields: {
        title: { type: 'string', required: true },
        published: { type: 'date' },
        slug: { type: 'string', translatable: false },
        status: { type: 'string', enum: ['draft', 'live'], default: 'draft' },
        site: { type: 'url' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    '@/article',
    '@acme/article'
  )

  it('carries model attributes and synthesizes one single brief section (root map)', () => {
    expect(decl.name).toBe('@acme/article')
    expect(decl.description).toBe('A post')
    // No schema-level brief / sort_date_field — both are inline now.
    expect(decl).not.toHaveProperty('brief')
    expect(decl).not.toHaveProperty('sort_date_field')
    expect(Object.keys(decl.sections)).toEqual(['article'])
    expect(decl.sections.article.brief).toBe(true)
    expect(decl.sections.article).not.toHaveProperty('multiple') // single
  })

  const fields = () => decl.sections.article.fields

  it('maps scalars 1:1 and required (no `key`, no `kind`)', () => {
    expect(fields().title).toMatchObject({ type: 'string', required: true })
    expect(fields().published).toMatchObject({ type: 'date' })
  })

  it('marks the brief date field with inline sort_date', () => {
    expect(fields().published.sort_date).toBe(true)
  })

  it('marks human text localized; not machine strings', () => {
    expect(fields().title.localized).toBe(true) // human text
    expect(fields().slug.localized).toBeUndefined() // translatable:false
    expect(fields().status.localized).toBeUndefined() // enum token
    expect(fields().site.localized).toBeUndefined() // url format
  })

  it('keeps enum on the field (the backend relocates it to a constraint at ingest)', () => {
    expect(fields().status).toEqual({ type: 'string', enum: ['draft', 'live'] })
  })

  it('keeps format on the field', () => {
    // url/email lower to a plain `string` field carrying `format`; the backend
    // relocates it to a section `format` constraint at ingest.
    expect(fields().site).toEqual({ type: 'string', format: 'url' })
  })

  it('drops field defaults (they ride in the foundation blob)', () => {
    expect(JSON.stringify(decl)).not.toContain('default')
  })

  it('lowers array-of-scalar → the scalar kind + multiple (no `array` type)', () => {
    // `localized` is not incidental here: a list of strings is text, and text
    // localizes unless opted out. It was absent until multi-valued leaves stopped
    // taking a shortcut past the attribute block — see the metadata describe below.
    expect(fields().tags).toEqual({ type: 'string', multiple: true, localized: true })
  })
})

/**
 * A multi-valued field is still a LEAF, and carries what a leaf carries.
 *
 * Every one of these used to be dropped. `lowerField` emitted the attribute block
 * only on its final fall-through, and each structural branch returned before
 * reaching it — so `{ type: string, many: true, required: true, enum: [...] }`
 * reached the wire as a bare `{ type: 'string', multiple: true }`: no closed set,
 * no format validation, no localization, not required.
 *
 * The giveaway was a split between the two reference kinds. `item_ref` fell
 * through and kept its label/description/required; `entity_ref` returned early and
 * lost them. Nothing had decided that — the control flow had.
 *
 * These are asserted per attribute rather than as one whole-object comparison, so
 * a future regression names the attribute it dropped.
 */
describe('toDataSchemaDeclaration — a multi-valued leaf keeps its attributes', () => {
  const field = (authored) => lower({ fields: { f: authored } }, '@/x', '@acme/x').sections.x.fields.f

  it('keeps label, description and required', () => {
    expect(field({ type: 'string', many: true, required: true, label: 'Tags', description: 'D' })).toEqual({
      type: 'string',
      multiple: true,
      label: 'Tags',
      description: 'D',
      required: true,
      localized: true,
    })
  })

  it('keeps a closed set — a multi-valued enum still narrows', () => {
    expect(field({ type: 'string', many: true, enum: ['a', 'b'] })).toEqual({
      type: 'string',
      multiple: true,
      enum: ['a', 'b'],
    })
  })

  it('keeps a value-validator format — a list of emails is still validated', () => {
    expect(field({ type: 'string', many: true, format: 'email' })).toEqual({
      type: 'string',
      multiple: true,
      format: 'email',
    })
  })

  it('localizes a list of text, and honours translatable: false', () => {
    // `@std/scene` authors `tags` with `translatable: false`. That declaration was
    // a no-op while lists never localized at all — which is the evidence that the
    // author expected the default to be the other way.
    expect(field({ type: 'string', many: true }).localized).toBe(true)
    expect(field({ type: 'string', many: true, translatable: false }).localized).toBeUndefined()
  })

  it('does not localize a machine-ish list (enum or value-validator format)', () => {
    expect(field({ type: 'string', many: true, enum: ['a'] }).localized).toBeUndefined()
    expect(field({ type: 'string', many: true, format: 'url' }).localized).toBeUndefined()
  })

  it('an UNTYPED array becomes json, not an invented `string`', () => {
    // The authoring format allows an array with no declared `items`. The lowering
    // used to fill that gap with `type: 'string'` — a claim about the elements the
    // author never made, and wrong the moment the list holds anything else.
    // `@std/form`'s `enum` is documented as "bare strings AND/OR { value, label }"
    // and was reaching the registry declared as a list of strings.
    expect(field({ type: 'array' })).toEqual({ type: 'json', multiple: true })
  })

  it('keeps the collection metadata on an untyped array, and does not localize it', () => {
    // `json` is opaque, so there is no text to translate — unlike the `string` it
    // used to be invented as, which picked up `localized: true` on the way.
    expect(field({ type: 'array', required: true, label: 'L', description: 'D' })).toEqual({
      type: 'json',
      multiple: true,
      label: 'L',
      description: 'D',
      required: true,
    })
  })

  it('a DECLARED element type is still lowered precisely', () => {
    // The fix must not blur a list that did say what it holds.
    expect(field({ type: 'string', many: true })).toEqual({ type: 'string', multiple: true, localized: true })
    expect(field({ type: 'int', many: true })).toEqual({ type: 'int', multiple: true })
  })

  it('refuses a stale `richtext` kind even when it is a list', () => {
    // Bypasses the normalizer deliberately, as the sibling guard test does: the
    // resolver folds `richtext` to json + format: prosemirror, so a raw kind only
    // survives in a stale PREBUILT schema.json handed straight to the lowering.
    //
    // The single-value case was already guarded. The list case was not — the old
    // array branch read `items.type` and returned without consulting the guard, so
    // the retired kind reached the wire as long as it was multi-valued.
    expect(() =>
      toDataSchemaDeclaration({ fields: { body: { type: 'array', items: { type: 'richtext' } } } }, { name: '@acme/x' })
    ).toThrow(/richtext/)
  })
})

describe('toDataSchemaDeclaration — a reference keeps its attributes', () => {
  const field = (authored) => lower({ fields: { f: authored } }, '@/x', '@acme/x').sections.x.fields.f

  it('entity_ref carries label, description and required', () => {
    expect(field({ ref: '@/person', required: true, label: 'Author', description: 'D' })).toEqual({
      type: 'entity_ref',
      label: 'Author',
      description: 'D',
      required: true,
      model: '@acme/person',
    })
  })

  it('a multi-valued entity_ref carries them too', () => {
    expect(field({ ref: '@/person', many: true, required: true, label: 'Authors' })).toEqual({
      type: 'entity_ref',
      multiple: true,
      label: 'Authors',
      required: true,
      model: '@acme/person',
    })
  })

  it('the two reference kinds agree', () => {
    // The asymmetry that exposed the bug: same declaration, one kind kept the
    // attributes and the other silently dropped them.
    const entity = field({ ref: '@/person', required: true, label: 'L', description: 'D' })
    const item = field({ type: 'string', options: '@/colors', required: true, label: 'L', description: 'D' })
    const attrs = (f) => ({ label: f.label, description: f.description, required: f.required })
    expect(attrs(entity)).toEqual(attrs(item))
  })

  it('a reference is never localized — the target localizes itself', () => {
    expect(field({ ref: '@/person' }).localized).toBeUndefined()
  })
})

/**
 * A SECTION takes prose but not `required` — and the split is the registry's,
 * answered 2026-08-05, not a guess we are hedging on.
 *
 *   label, description   ACCEPTED and stored on the section, keyed for
 *                        translation as `section.<name>.label` / `.description`.
 *   required             a HARD ERROR: "carries leaf-only attribute required —
 *                        it belongs on a leaf field, not a section."
 *
 * So the drop is not symmetric and never was. The prose was ours to fix; the
 * flag is theirs to declare, and they have deliberately not: it would not be
 * sugar over `min_items: 1` (which only stops you deleting the last record — it
 * cannot make an entity have one), so section-required needs an entity-level
 * completeness check that does not exist. A flag nothing enforces is worse than
 * no flag. `@std/publication`'s `authors` is the standing authoring case.
 *
 * The producer must therefore keep dropping `required` here — emitting it would
 * fail the publish outright, the way `info.submit` did.
 */
describe('toDataSchemaDeclaration — section prose travels, section `required` does not', () => {
  const field = (authored) => lower({ fields: { f: authored } }, '@/x', '@acme/x').sections.x.fields.f

  it('a nested object carries label and description onto the section', () => {
    expect(field({ type: 'object', label: 'L', description: 'D', fields: { a: 'string' } })).toEqual({
      type: 'section',
      label: 'L',
      description: 'D',
      fields: { a: { type: 'string', localized: true } },
    })
  })

  it('a list of records carries them too', () => {
    const out = field({ type: 'object', many: true, label: 'L', description: 'D', fields: { a: 'string' } })
    expect(out).toMatchObject({ type: 'section', multiple: true, label: 'L', description: 'D' })
  })

  it('an open map carries the field prose onto its rows section', () => {
    const out = field({
      type: 'object',
      description: 'The form controls',
      values: { type: 'object', fields: { type: { type: 'string', required: true } } },
    })
    expect(out).toMatchObject({ type: 'section', multiple: true, description: 'The form controls' })
  })

  it('an authored ROOT section keeps its prose through normalize + lower', () => {
    // The normalizer used to drop these before the lowering could see them, so
    // this asserts the whole path rather than just the second half.
    const decl = lower(
      { sections: { identity: { brief: true, label: 'Identity', description: 'The card', fields: { a: 'string' } } } },
      '@/x',
      '@acme/x'
    )
    expect(decl.sections.identity).toMatchObject({ label: 'Identity', description: 'The card' })
  })

  it('NEVER emits `required` on a section — the registry rejects it outright', () => {
    const nested = field({ type: 'object', required: true, label: 'L', fields: { a: 'string' } })
    const list = field({ type: 'object', many: true, required: true, fields: { a: 'string' } })
    expect(nested).not.toHaveProperty('required')
    expect(list).not.toHaveProperty('required')
  })

  it('a leaf keeps `required` — that is where it belongs', () => {
    expect(field({ type: 'string', required: true }).required).toBe(true)
  })
})

/**
 * `constraints` on a section-shaped FIELD.
 *
 * Section rules were declarable only in the `sections:` form, but a list of
 * records is normally authored as a field — `authors: { type: object, many: true }`
 * — so the rules were unreachable in the shape that usually needs them. They were
 * accepted at every stage and silently discarded, which is exactly why this looked
 * supported: a `many:` field even carried them through normalization, because the
 * `many` expansion copies every non-item key onto the array.
 *
 * `min_items` is the motivating rule, and its scope is narrow in two directions
 * worth stating where someone will read them: it is a WRITE guarantee (a delete
 * may not take the section below N — it cannot force an author to populate it),
 * and never a RENDER guarantee (the same Model is renderable by a foundation that
 * never saw the constraint, so components still handle an empty list).
 */
describe('toDataSchemaDeclaration — a section-shaped field carries its constraints', () => {
  const field = (authored) => lower({ fields: { f: authored } }, '@/x', '@acme/x').sections.x.fields.f
  const MIN1 = [{ kind: 'min_items', value: 1 }]

  it('a list of records carries them — the shape that needed this', () => {
    const out = field({ type: 'object', many: true, constraints: MIN1, fields: { a: 'string' } })
    expect(out).toMatchObject({ type: 'section', multiple: true, constraints: MIN1 })
  })

  it('a nested object carries them too', () => {
    expect(field({ type: 'object', constraints: MIN1, fields: { a: 'string' } }).constraints).toEqual(MIN1)
  })

  it('an open map MERGES them with its structural uniqueness rule', () => {
    // The `unique_field` rule is what makes the map's key the row identity, so an
    // author's own constraints must add to it and can never replace it.
    const out = field({
      type: 'object',
      constraints: MIN1,
      values: { type: 'object', fields: { t: { type: 'string', required: true } } },
    })
    expect(out.constraints).toEqual([
      { kind: 'unique_field', field: 'name', scope: 'section' },
      { kind: 'min_items', value: 1 },
    ])
  })

  it('a leaf drops them — the wire has no slot, and that is not an error', () => {
    // Well-formed authoring the registry has no home for. Failing a build over it
    // would break a project that never registers at all, so it is documented
    // rather than enforced; a leaf narrows with `enum` / `format` instead.
    expect(field({ type: 'string', constraints: MIN1 })).not.toHaveProperty('constraints')
  })

  it('@std/publication declares min_items on its authors, and it reaches the wire', async () => {
    const { publication } = await import('@uniweb/schemas')
    const decl = lower(publication, '@std/publication', '@std/publication')
    expect(decl.sections.publication.fields.authors.constraints).toEqual([{ kind: 'min_items', value: 1 }])
  })
})

/**
 * `tree` and `append_only` on a section-shaped field — the same silent drop as
 * `constraints`, found while checking a stale claim that `self_nesting` was
 * top-level-only (it is not — a nested self-nesting section is shipped in one of
 * the registry's own system Models).
 *
 * A list of records authored as a FIELD could not be a tree or append-only, while
 * the identical thing in `sections:` form could. Nothing decided that either.
 */
describe('toDataSchemaDeclaration — a section-shaped field carries tree and append_only', () => {
  const field = (authored) => lower({ fields: { f: authored } }, '@/x', '@acme/x').sections.x.fields.f

  it('`tree` becomes self_nesting on the section', () => {
    const out = field({ type: 'object', many: true, tree: true, fields: { a: 'string' } })
    expect(out).toMatchObject({ type: 'section', multiple: true, self_nesting: true })
  })

  it('`append_only` carries', () => {
    expect(field({ type: 'object', many: true, append_only: true, fields: { a: 'string' } }).append_only).toBe(true)
  })

  it('both together, alongside the other section attributes', () => {
    const out = field({
      type: 'object',
      many: true,
      tree: true,
      append_only: true,
      description: 'D',
      constraints: [{ kind: 'min_items', value: 1 }],
      fields: { a: 'string' },
    })
    expect(out).toMatchObject({
      type: 'section',
      multiple: true,
      self_nesting: true,
      append_only: true,
      description: 'D',
      constraints: [{ kind: 'min_items', value: 1 }],
    })
  })

  it('a nested section in the sections-form still self-nests', () => {
    // Guards the case the stale doc claimed was invalid.
    const decl = lower(
      { sections: { root: { sections: { kids: { many: true, tree: true, fields: { a: 'string' } } } } } },
      '@/y',
      '@acme/y'
    )
    expect(decl.sections.root.fields.kids.self_nesting).toBe(true)
  })
})

describe('toDataSchemaDeclaration — json + format: prosemirror (content fields)', () => {
  const decl = lower(
    {
      name: 'doc',
      fields: {
        body: { type: 'json', format: 'prosemirror' }, // rich content
        meta: { type: 'json' }, // plain structured json
        site: { type: 'url' }, // string + format: url (machine-ish)
      },
    },
    '@/doc',
    '@acme/doc'
  )
  const f = () => decl.sections.doc.fields

  it('marks a format: prosemirror json field localized (content, not machine-ish)', () => {
    // Like url/email, `format` rides on the field — but prosemirror is a MARKER,
    // not a validator: the backend carries it and surfaces it in schema reads (so
    // the app mounts a rich-text editor), it does NOT relocate it to a section
    // constraint the way it does the email/url/enum validators.
    expect(f().body).toEqual({ type: 'json', format: 'prosemirror', localized: true })
  })

  it('leaves a plain json field non-localized', () => {
    expect(f().meta.localized).toBeUndefined()
  })

  it('keeps a string format (url/email) non-localized', () => {
    expect(f().site.localized).toBeUndefined()
  })
})

describe('toDataSchemaDeclaration — references', () => {
  const decl = lower(
    {
      fields: {
        author: { type: 'ref', ref: '@/person' },
        editors: { type: 'array', items: { type: 'ref', ref: '@/person' } },
        country: { type: 'string', options: '@/countries' },
        crossorg: { type: 'ref', ref: '@std/person' },
      },
    },
    '@/x',
    '@acme/doc'
  )
  const fields = decl.sections[briefName(decl)].fields

  it('ref → entity_ref with the name resolved into the schema org (scalar model)', () => {
    expect(fields.author).toEqual({ type: 'entity_ref', model: '@acme/person' })
  })

  it('array-of-ref → entity_ref + multiple (the `array` Kind is retired)', () => {
    expect(fields.editors).toEqual({ type: 'entity_ref', multiple: true, model: '@acme/person' })
  })

  it('options → item_ref to the resolved model', () => {
    expect(fields.country).toEqual({ type: 'item_ref', options: '@acme/countries' })
  })

  it('passes a non-self scope through unchanged', () => {
    expect(fields.crossorg.model).toBe('@std/person')
  })

  it('honors a custom resolveName', () => {
    const norm = validateAndNormalizeSchema({ fields: { a: { type: 'ref', ref: '@/person' } } }, '@/x')
    const d = toDataSchemaDeclaration(norm, { name: '@acme/doc', resolveName: () => '@registry/Person' })
    expect(d.sections[briefName(d)].fields.a.model).toBe('@registry/Person')
  })

  it('uses resolveOptions for the full @/x/<section> item_ref path (§10.1)', () => {
    const norm = validateAndNormalizeSchema({ fields: { c: { type: 'string', options: '@/colors' } } }, '@/x')
    const d = toDataSchemaDeclaration(norm, { name: '@acme/doc', resolveOptions: (r) => `${r}/values` })
    expect(d.sections[briefName(d)].fields.c).toEqual({ type: 'item_ref', options: '@/colors/values' })
  })
})

describe('toDataSchemaDeclaration — brief & linkable', () => {
  it('omits linkable when a brief section exists (default true)', () => {
    const d = lower({ fields: { name: { type: 'string' } } }, '@/x', '@acme/x')
    expect(briefName(d)).toBe('x')
    expect(d.sections.x.brief).toBe(true)
    expect(d).not.toHaveProperty('linkable')
  })

  it('emits linkable:false for a brief-less model (no single section)', () => {
    const d = lower(
      { sections: { items: { kind: 'multi', nestable: true, fields: { label: { type: 'string' } } } } },
      '@/nav',
      '@std/nav'
    )
    expect(briefName(d)).toBeUndefined()
    expect(d.linkable).toBe(false)
    expect(d.sections.items).toMatchObject({ multiple: true, self_nesting: true })
  })
})

describe('toDataSchemaDeclaration — nesting → type: section fields', () => {
  const decl = lower(
    {
      fields: {
        name: { type: 'string', required: true },
        social: { type: 'object', fields: { handle: { type: 'string' }, verified: { type: 'bool' } } },
        results: {
          type: 'array',
          items: { type: 'object', fields: { metric: { type: 'string' }, value: { type: 'int' } } },
        },
      },
    },
    '@/x',
    '@acme/profile'
  )
  const fields = decl.sections[briefName(decl)].fields

  it('object field → a nested single section (type: section)', () => {
    expect(fields.social.type).toBe('section')
    expect(fields.social).not.toHaveProperty('multiple') // single
    expect(fields.social.fields.handle).toMatchObject({ type: 'string' })
  })

  it('array-of-object field → a nested multi section', () => {
    expect(fields.results).toMatchObject({ type: 'section', multiple: true })
    expect(fields.results.fields.value).toEqual({ type: 'int' })
  })

  it('keeps plain scalars as leaf fields alongside nested sections', () => {
    expect(fields.name).toMatchObject({ type: 'string', required: true })
  })
})

describe('toDataSchemaDeclaration — sections-form', () => {
  const decl = lower(
    {
      sections: {
        card: { kind: 'single', fields: { title: { type: 'string' } } },
        outline: { kind: 'multi', nestable: true, fields: { heading: { type: 'string' } } },
        meta: { kind: 'single', brief: true, fields: { ref_code: { type: 'string' } } },
      },
    },
    '@/x',
    '@acme/doc'
  )

  it('emits the sections map in declared order', () => {
    expect(Object.keys(decl.sections)).toEqual(['card', 'outline', 'meta'])
  })

  it('marks the brief:true section inline (no schema-level back-reference)', () => {
    expect(briefName(decl)).toBe('meta')
    expect(decl.sections.meta.brief).toBe(true)
    expect(decl.sections.card).not.toHaveProperty('brief')
  })

  it('lowers nestable → self_nesting on a multi section', () => {
    expect(decl.sections.outline).toMatchObject({ multiple: true, self_nesting: true })
  })

  it('passes append_only through on a multi section (insert-only records)', () => {
    const d = lower(
      { sections: { activity: { kind: 'multi', append_only: true, fields: { event: { type: 'string' } } } } },
      '@/x',
      '@acme/log'
    )
    expect(d.sections.activity).toMatchObject({ multiple: true, append_only: true })
  })

  it('infers + stamps the first single as brief when none is marked', () => {
    const d = lower(
      { sections: { a: { kind: 'multi', fields: { x: { type: 'string' } } }, b: { kind: 'single', fields: { y: { type: 'string' } } } } },
      '@/x',
      '@acme/d'
    )
    expect(briefName(d)).toBe('b')
    expect(d.sections.b.brief).toBe(true)
  })
})

describe('toDataSchemaDeclaration — guards', () => {
  it('requires a registry name', () => {
    expect(() => toDataSchemaDeclaration({ fields: {} })).toThrow(/registry name is required/)
  })

  it('rejects a stale raw `richtext` kind (a pre-migration prebuilt schema needs a rebuild)', () => {
    // `richtext` is the resolver alias for json + format: prosemirror; a raw `richtext`
    // kind only survives in a stale prebuilt schema.json, which must be rebuilt.
    expect(() =>
      toDataSchemaDeclaration({ fields: { body: { type: 'richtext' } } }, { name: '@acme/x' })
    ).toThrow(/richtext/)
  })
})

/**
 * An OPEN MAP (`values:`) — an object whose keys belong to the author and whose
 * values share one schema.
 *
 * It lowers to ROWS: a `multi` section whose key field carries what was the object
 * key, with a section-scoped uniqueness rule making that key the row's identity.
 * That is the same shape `array of object` already lowers to, and the idiom the
 * store already uses for this (its site-content `collections` section), so an open
 * map and a hand-authored row set produce one wire shape rather than two spellings.
 *
 * Until 2026-08-05 `values:` had no lowering at all: the object branch read
 * `field.fields`, which an open map does not declare, so the section was emitted
 * with no fields. `@std/form` shipped that way and a consumer's validator rejected
 * it at restore — correctly, and at the last possible moment.
 */
describe('toDataSchemaDeclaration — open map (values:)', () => {
  const decl = lower(
    {
      name: 'form',
      fields: {
        title: { type: 'string' },
        fields: {
          type: 'object',
          required: true,
          values: {
            type: 'object',
            fields: {
              type: { type: 'string', required: true },
              label: { type: 'string' },
              required: { type: 'bool' }
            }
          }
        }
      }
    },
    '@std/form',
    '@std/form'
  )
  const map = decl.sections.form.fields.fields

  test('lowers to a nested section, not a leaf', () => {
    expect(map.type).toBe('section')
  })

  test('the section is MULTI — an open map is rows, not a singleton', () => {
    // The original bug: lowered as `kind: single`, which is a collection lowered
    // as one record.
    expect(map.multiple).toBe(true)
  })

  test('the map key becomes a required `name` field, first in the namespace', () => {
    expect(Object.keys(map.fields)[0]).toBe('name')
    expect(map.fields.name.type).toBe('string')
    expect(map.fields.name.required).toBe(true)
  })

  test('the key is NOT localized — a per-locale key would destroy identity', () => {
    // String fields localize by default. A key that differed per locale would mean
    // the same row is two rows, which is exactly what the key exists to prevent.
    expect(map.fields.name.localized).toBeUndefined()
  })

  test('the key carries a section-scoped uniqueness rule', () => {
    expect(map.constraints).toEqual([
      { kind: 'unique_field', field: 'name', scope: 'section' }
    ])
  })

  test('the value schema becomes ordinary declared fields beside the key', () => {
    // The point of rows over `type: json`: every value field stays a real field the
    // store validates, rather than an opaque blob.
    expect(Object.keys(map.fields)).toEqual(['name', 'type', 'label', 'required'])
    expect(map.fields.type.required).toBe(true)
    expect(map.fields.required.type).toBe('bool')
  })

  test('a value schema declaring its own `name` is an error, not a silent overwrite', () => {
    expect(() =>
      lower(
        {
          name: 'x',
          fields: {
            m: {
              type: 'object',
              values: { type: 'object', fields: { name: { type: 'string' } } }
            }
          }
        },
        '@t/x',
        '@t/x'
      )
    ).toThrow(/value field named 'name'/)
  })

  test('`values` that is not an object with fields is an error — a row needs columns', () => {
    expect(() =>
      lower(
        { name: 'x', fields: { m: { type: 'object', values: { type: 'string' } } } },
        '@t/x',
        '@t/x'
      )
    ).toThrow(/lowers to rows/)
  })
})

/**
 * A section with neither leaves nor sub-sections carries nothing. Emitting one is
 * what let `@std/form` reach a consumer's restore in a state no producer should
 * have shipped; refusing here moves that to the schema author's screen.
 */
describe('toDataSchemaDeclaration — leafless sections are refused', () => {
  test('an empty section throws, naming the path', () => {
    expect(() =>
      lower({ name: 'x', sections: { empty: { fields: {} } } }, '@t/x', '@t/x')
    ).toThrow(/section 'empty' declares no fields/)
  })
})
