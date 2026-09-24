// Collections-lane pull projection (recordsToProject, P1).
//
// The folder document is built with the REAL producer (buildFolderEntity) so the
// projection is exercised against the exact wire shape it inverts.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  buildFolderEntity,
  recordsToProject,
  findRecordFileByUuid,
  servedFingerprint,
  updateBackendMap,
  documentSchema,
} from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-collections-project-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// An article Model: brief section with a localized title + a markup-text body.
const articleDecl = {
  name: '@acme/article',
  sections: {
    article: {
      brief: true,
      fields: { title: { type: 'string', localized: true }, body: { type: 'text', format: 'markdown', localized: true } },
    },
  },
}
// A widget Model: brief section, no content body (→ YAML default format).
const widgetDecl = {
  name: '@acme/widget',
  sections: { widget: { brief: true, fields: { title: { type: 'string' }, price: { type: 'number' } } } },
}

const resolveDeclaration = (name) => ({ '@acme/article': articleDecl, '@acme/widget': widgetDecl }[name] || null)

const articleDoc = (uuid, title, body) => ({
  $uuid: uuid,
  $schema: '@acme/article',
  article: { $uuid: 'rec', title: { en: title }, body: { en: body } },
})

// A faithful folder document from the real producer, given record placements. (The
// folder carries no $uuid — the backend owns it, keyed by the site-content uuid — so a
// second arg some call sites still pass is ignored.)
// A stored folder document, as the backend would return it — one branch per
// group, records as leaves. The tree is AUTHORED now (`records/folder.yml`), so the
// helper builds the resolved nodes the producer would have been given.
const folderFor = (records) =>
  buildFolderEntity({
    recordEntities: records,
    folderNodes: [
      ...new Map(records.map((r) => [r.collection, r.collection])).keys(),
    ].map((seg) => ({
      kind: 'branch',
      name: seg,
      $children: records
        .filter((r) => r.collection === seg)
        .map((r) => ({ kind: 'ref', $entityId: r.id })),
    })),
  }).document

describe('recordsToProject — placement', () => {
  it('places a new markdown record under collections/<collection>/<slug>.md (slug+collection from the folder)', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [articleDoc('U1', 'Hello', '\n# Hi\n')]

    const report = recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration } })

    const f = join(dir, 'records/acme/article/hello.md')
    expect(report.placed).toEqual([f])
    expect(readFileSync(f, 'utf8')).toBe('---\n$uuid: U1\ntitle: Hello\n---\n\n# Hi\n')
  })

  it('defaults a no-content-body Model to a YAML file', () => {
    const folderDoc = folderFor([{ id: 'widgets/w1', uuid: 'W1', slug: 'w1', collection: 'widgets' }], 'F1')
    const recordDocs = [{ $uuid: 'W1', $schema: '@acme/widget', widget: { title: 'Gear', price: 9.99 } }]

    recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration } })

    const f = join(dir, 'records/acme/widget/w1.yml')
    expect(existsSync(f)).toBe(true)
    expect(yaml.load(readFileSync(f, 'utf8'))).toEqual({ $uuid: 'W1', title: 'Gear', price: 9.99 })
  })

  // ⛔ THE 'path override' CASE IS GONE, and its replacement is the assertion that
  // a record's home is decided by WHAT IT IS. A query has no directory to
  // override — `records/{schema}/` is the pool — so placement follows `$schema`
  // and survives a query being renamed, added or deleted, none of which is a fact
  // about the record.
  it('places by the MODEL, not by any query that happens to select the record', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')

    recordsToProject({
      folderDoc,
      recordDocs: [articleDoc('U1', 'Hello', '\nHi\n')],
      siteRoot: dir,
      // No config at all: nothing about a query can change where this lands.
      opts: { resolveDeclaration },
    })

    expect(existsSync(join(dir, 'records/acme/article/hello.md'))).toBe(true)
  })

  it('reports — never silently drops — a model that names no pool folder', () => {
    const folderDoc = folderFor([{ id: 'x/hello', uuid: 'U1', slug: 'hello', collection: 'x' }], 'F1')
    const doc = { ...articleDoc('U1', 'Hello', '\nHi\n'), $schema: 'not-a-ref' }

    const report = recordsToProject({
      folderDoc,
      recordDocs: [doc],
      siteRoot: dir,
      opts: { resolveDeclaration: () => resolveDeclaration('@acme/article') },
    })

    expect(report.placed).toEqual([])
    expect(report.skipped[0].reason).toContain('names no pool folder')
  })

  it('falls back to the record $id when the record is not in the folder', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const orphan = { ...articleDoc('U9', 'Bonus', '\nExtra\n'), $id: 'extras/bonus' }

    const report = recordsToProject({ folderDoc, recordDocs: [orphan], siteRoot: dir, opts: { resolveDeclaration } })

    expect(report.placed).toEqual([join(dir, 'records/acme/article/bonus.md')])
  })
})

describe('recordsToProject — update in place by $uuid', () => {
  it('re-renders over an existing file matched by $uuid, preserving its format and filename', () => {
    // Existing file: a different filename than the slug, in YAML, carrying U2.
    mkdirSync(join(dir, 'records/acme/article'), { recursive: true })
    const existing = join(dir, 'records/acme/article/legacy-name.yml')
    writeFileSync(existing, '$uuid: U2\ntitle: Old Title\n')

    expect(findRecordFileByUuid(join(dir, 'records/acme/article'), 'U2')).toEqual({ path: existing, format: 'yaml' })

    const folderDoc = folderFor([{ id: 'articles/fresh', uuid: 'U2', slug: 'fresh', collection: 'articles' }], 'F1')
    const report = recordsToProject({
      folderDoc,
      recordDocs: [articleDoc('U2', 'New Title', '\nbody\n')],
      siteRoot: dir,
      opts: { resolveDeclaration },
    })

    // Updated the existing file (not placed a new fresh.md); stayed YAML.
    expect(report.updated).toEqual([existing])
    expect(existsSync(join(dir, 'records/acme/article/fresh.md'))).toBe(false)
    expect(yaml.load(readFileSync(existing, 'utf8'))).toEqual({ $uuid: 'U2', title: 'New Title', body: '\nbody\n' })
  })

  it('is idempotent — a second projection reports unchanged', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [articleDoc('U1', 'Hello', '\n# Hi\n')]
    const o = { resolveDeclaration }

    recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: o })
    const report = recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: o })
    expect(report.unchanged).toEqual([join(dir, 'records/acme/article/hello.md')])
    expect(report.placed).toEqual([])
  })
})

describe('recordsToProject — folder identity + no silent skips', () => {
  it('does not persist a folder $uuid — the backend owns the folder (keyed by the site-content uuid)', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }])
    recordsToProject({ folderDoc, recordDocs: [articleDoc('U1', 'Hi', '\nx\n')], siteRoot: dir, opts: { resolveDeclaration } })

    // the record is placed, but no folder identity is written to collections.yml
    expect(existsSync(join(dir, 'records/acme/article/hello.md'))).toBe(true)
    expect(existsSync(join(dir, 'collections/collections.yml'))).toBe(false)
  })

  it('skips (does not crash on) a record whose model cannot be resolved', () => {
    const folderDoc = folderFor([{ id: 'mystery/x', uuid: 'M1', slug: 'x', collection: 'mystery' }], 'F1')
    const report = recordsToProject({
      folderDoc,
      recordDocs: [{ $uuid: 'M1', $schema: '@acme/unknown', mystery: {} }],
      siteRoot: dir,
      opts: { resolveDeclaration },
    })
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]).toMatchObject({ uuid: 'M1', reason: expect.stringContaining('@acme/unknown') })
  })
})

describe('recordsToProject — the data schema is named by `$schema`', () => {
  // ⭐ Agreed with backend 2026-09-24: an entity names its data schema by `$schema`
  // (the scoped name), an open-form reference by `schema`. The key was `$model`, and
  // no fallback reads it — there was no production backend to keep a window for.
  it('documentSchema reads `$schema`, and only `$schema`', () => {
    expect(documentSchema({ $schema: '@acme/widget' })).toBe('@acme/widget')
    expect(documentSchema({ $model: '@acme/widget' })).toBeNull()
    expect(documentSchema({ widget: {} })).toBeNull()
    expect(documentSchema(null)).toBeNull()
  })

  it('places a record whose data schema is named by `$schema`', () => {
    const folderDoc = folderFor([{ id: 'widgets/w1', uuid: 'W1', slug: 'w1', collection: 'widgets' }])
    const report = recordsToProject({
      folderDoc,
      recordDocs: [{ $uuid: 'W1', $schema: '@acme/widget', widget: { title: 'Gear', price: 9.99 } }],
      siteRoot: dir,
      opts: { resolveDeclaration },
    })
    const f = join(dir, 'records/acme/widget/w1.yml')
    expect(report.placed).toEqual([f])
    expect(yaml.load(readFileSync(f, 'utf8'))).toEqual({ $uuid: 'W1', title: 'Gear', price: 9.99 })
  })

  // ⛔ What a partly applied push left (before the backend's push became one
  // transaction, 2026-09-24): an entity with no Sections. It cannot be
  // rendered, so it is not placed — and a caller counting what it placed must see it.
  it('a record that cannot be written is a skip, not a warning', () => {
    const folderDoc = folderFor([{ id: 'widgets/w1', uuid: 'W1', slug: 'w1', collection: 'widgets' }])
    const report = recordsToProject({
      folderDoc,
      recordDocs: [{ $uuid: 'W1', $schema: '@acme/widget' }],
      siteRoot: dir,
      opts: { resolveDeclaration },
    })
    expect(report.placed).toEqual([])
    expect(report.skipped).toEqual([
      { uuid: 'W1', slug: 'w1', reason: expect.stringContaining('no resolvable brief section') },
    ])
    expect(report.warnings.filter((w) => w.startsWith('w1:'))).toEqual([])
  })
})

describe("recordsToProject — the author's asset paths come back", () => {
  // ⛔ A pushed record goes up with the serve URL the push put where its author wrote
  // `/images/alice.png`, and a pull brings it back that way. The content lane has put
  // the author's path back from `sync.json`'s asset map since 2026-09-10; the records
  // lane rewrote the author's file to the backend route until 2026-09-23.
  const BACKEND = 'http://backend.test'
  const personDecl = {
    name: '@acme/person',
    sections: { person: { brief: true, fields: { name: { type: 'string' }, photo: { type: 'file' } } } },
  }
  const pulled = (photo) => {
    updateBackendMap(dir, BACKEND, 'assets', {
      '/images/alice.png': { id: 'A1', ext: 'png', served: servedFingerprint('/serve/A1/base.png') },
    })
    recordsToProject({
      folderDoc: folderFor([{ id: 'person/alice', uuid: 'P1', slug: 'alice', collection: 'person' }]),
      recordDocs: [{ $uuid: 'P1', $schema: '@acme/person', person: { name: 'Alice', photo } }],
      siteRoot: dir,
      opts: { resolveDeclaration: (n) => (n === '@acme/person' ? personDecl : null), backend: BACKEND },
    })
    return yaml.load(readFileSync(join(dir, 'records/acme/person/alice.yml'), 'utf8')).photo
  }

  it('⛔ a serve URL the push recorded is written back as the path the author wrote', () => {
    expect(pulled('/serve/A1/base.png')).toBe('/images/alice.png')
  })

  it('CONTROL — an address this project never pushed stays the address that works', () => {
    expect(pulled('/serve/B2/base.png')).toBe('/serve/B2/base.png')
  })
})

describe('recordsToProject — prosemirror content field (B)', () => {
  const pmDecl = {
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
  const resolvePm = (n) => (n === '@acme/article' ? pmDecl : null)
  const pmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] }

  it('renders a PM-doc body to markdown (.md) and flushes its structural map to locales/records', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [
      { $uuid: 'U1', $schema: '@acme/article', article: { title: { en: 'Hello' }, body: { en: pmDoc, es: { 'Hello world': 'Hola mundo' } } } },
    ]

    const report = recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration: resolvePm } })

    // body field (prosemirror) → markdown body in a .md file (briefHasContentBody → md format)
    const f = join(dir, 'records/acme/article/hello.md')
    expect(report.placed).toContain(f)
    expect(readFileSync(f, 'utf8')).toContain('Hello world')
    // the target structural map → locales/records/es.json by source-text hash
    const es = JSON.parse(readFileSync(join(dir, 'locales/records/es.json'), 'utf8'))
    expect(es[computeHash('Hello world')]).toBe('Hola mundo')
  })
})

describe('recordsToProject — localized record scalars (B)', () => {
  it('writes the source field inline and target locales to locales/records/{locale}.json', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    // A record with a multi-locale title scalar (and a source-only markup-text body).
    const recordDocs = [
      { $uuid: 'U1', $schema: '@acme/article', article: { $uuid: 'rec', title: { en: 'Hello', es: 'Hola' }, body: { en: '\nHi\n' } } },
    ]

    const report = recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration } })

    // source-locale title stays inline in the record file
    const f = join(dir, 'records/acme/article/hello.md')
    expect(readFileSync(f, 'utf8')).toContain('title: Hello')
    // target locale → locales/records/es.json keyed by hash(source)
    const es = JSON.parse(readFileSync(join(dir, 'locales/records/es.json'), 'utf8'))
    expect(es[computeHash('Hello')]).toBe('Hola')
    expect(report.locales.es).toBe('updated')
  })
})

describe('recordsToProject — prosemirror body free-form override (B-1)', () => {
  // A Model whose brief body is a `format: prosemirror` json field (a PM doc on the
  // wire), so a target locale can carry a full free-form body, not just a map.
  const pmDecl = {
    name: '@acme/pmarticle',
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
  const pmResolve = (name) => (name === '@acme/pmarticle' ? pmDecl : null)
  const srcDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi there' }] }] }
  // A genuine free-form override DIVERGES structurally from the source (two paragraphs
  // vs one) — a structurally congruent body is recovered as a structural map instead.
  const ffDoc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hola distinto uno' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Hola distinto dos' }] },
  ] }

  it('writes a target-locale full-doc body to locales/freeform/{locale}/records/', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [
      { $uuid: 'U1', $schema: '@acme/pmarticle', article: { $uuid: 'rec', title: { en: 'T' }, body: { en: srcDoc, es: ffDoc } } },
    ]

    const report = recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration: pmResolve } })

    // source-locale body → the record .md, in ITS model's pool folder
    expect(readFileSync(join(dir, 'records/acme/pmarticle/hello.md'), 'utf8')).toContain('Hi there')
    // ⭐ the target-locale full body mirrors the pool, NOT any query name — so two
    // queries over one schema find one translation instead of needing two copies.
    const ff = join(dir, 'locales/freeform/es/records/acme/pmarticle/hello.md')
    expect(report.freeform.written).toContain(ff)
    expect(readFileSync(ff, 'utf8')).toContain('Hola distinto')
  })

  it('a structural-map target stays a map in locales/records (no free-form file)', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U2', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [
      { $uuid: 'U2', $schema: '@acme/pmarticle', article: { $uuid: 'rec', title: { en: 'T' }, body: { en: srcDoc, es: { 'Hi there': 'Hola ahi' } } } },
    ]

    const report = recordsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration: pmResolve } })

    const es = JSON.parse(readFileSync(join(dir, 'locales/records/es.json'), 'utf8'))
    expect(es[computeHash('Hi there')]).toBe('Hola ahi')
    expect(report.freeform.written).toEqual([])
    expect(existsSync(join(dir, 'locales/freeform/es/records/acme/article/hello.md'))).toBe(false)
  })
})
