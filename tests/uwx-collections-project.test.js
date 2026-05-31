// Collections-lane pull projection (collectionsToProject, P1).
//
// The folder document is built with the REAL producer (buildFolderEntity) so the
// projection is exercised against the exact wire shape it inverts.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  buildFolderEntity,
  collectionsToProject,
  findRecordFileByUuid,
} from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-collections-project-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// An article Model: brief section with a localized title + a richtext body.
const articleDecl = {
  name: '@acme/article',
  sections: {
    article: {
      brief: true,
      fields: { title: { type: 'string', localized: true }, body: { type: 'richtext', localized: true } },
    },
  },
}
// A widget Model: brief section, no richtext (→ YAML default format).
const widgetDecl = {
  name: '@acme/widget',
  sections: { widget: { brief: true, fields: { title: { type: 'string' }, price: { type: 'number' } } } },
}

const resolveDeclaration = (name) => ({ '@acme/article': articleDecl, '@acme/widget': widgetDecl }[name] || null)

const articleDoc = (uuid, title, body) => ({
  $uuid: uuid,
  $model: '@acme/article',
  article: { $uuid: 'rec', title: { en: title }, body: { en: body } },
})

// A faithful folder document from the real producer, given record placements.
const folderFor = (records, folderUuid) =>
  buildFolderEntity({ recordEntities: records, folderUuid }).document

describe('collectionsToProject — placement', () => {
  it('places a new markdown record under collections/<collection>/<slug>.md (slug+collection from the folder)', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [articleDoc('U1', 'Hello', '\n# Hi\n')]

    const report = collectionsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration } })

    const f = join(dir, 'collections/articles/hello.md')
    expect(report.placed).toEqual([f])
    expect(readFileSync(f, 'utf8')).toBe('---\n$uuid: U1\ntitle: Hello\n---\n\n# Hi\n')
  })

  it('defaults a no-richtext Model to a YAML file', () => {
    const folderDoc = folderFor([{ id: 'widgets/w1', uuid: 'W1', slug: 'w1', collection: 'widgets' }], 'F1')
    const recordDocs = [{ $uuid: 'W1', $model: '@acme/widget', widget: { title: 'Gear', price: 9.99 } }]

    collectionsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration } })

    const f = join(dir, 'collections/widgets/w1.yml')
    expect(existsSync(f)).toBe(true)
    expect(yaml.load(readFileSync(f, 'utf8'))).toEqual({ $uuid: 'W1', title: 'Gear', price: 9.99 })
  })

  it('honors a collections-config path override', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const collectionsConfig = { declarations: { articles: { name: 'articles', path: 'content/arts' } } }

    collectionsToProject({
      folderDoc,
      recordDocs: [articleDoc('U1', 'Hello', '\nHi\n')],
      siteRoot: dir,
      opts: { resolveDeclaration, collectionsConfig },
    })

    expect(existsSync(join(dir, 'content/arts/hello.md'))).toBe(true)
  })

  it('falls back to the record $id when the record is not in the folder', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const orphan = { ...articleDoc('U9', 'Bonus', '\nExtra\n'), $id: 'extras/bonus' }

    const report = collectionsToProject({ folderDoc, recordDocs: [orphan], siteRoot: dir, opts: { resolveDeclaration } })

    expect(report.placed).toEqual([join(dir, 'collections/extras/bonus.md')])
  })
})

describe('collectionsToProject — update in place by $uuid', () => {
  it('re-renders over an existing file matched by $uuid, preserving its format and filename', () => {
    // Existing file: a different filename than the slug, in YAML, carrying U2.
    mkdirSync(join(dir, 'collections/articles'), { recursive: true })
    const existing = join(dir, 'collections/articles/legacy-name.yml')
    writeFileSync(existing, '$uuid: U2\ntitle: Old Title\n')

    expect(findRecordFileByUuid(join(dir, 'collections/articles'), 'U2')).toEqual({ path: existing, format: 'yaml' })

    const folderDoc = folderFor([{ id: 'articles/fresh', uuid: 'U2', slug: 'fresh', collection: 'articles' }], 'F1')
    const report = collectionsToProject({
      folderDoc,
      recordDocs: [articleDoc('U2', 'New Title', '\nbody\n')],
      siteRoot: dir,
      opts: { resolveDeclaration },
    })

    // Updated the existing file (not placed a new fresh.md); stayed YAML.
    expect(report.updated).toEqual([existing])
    expect(existsSync(join(dir, 'collections/articles/fresh.md'))).toBe(false)
    expect(yaml.load(readFileSync(existing, 'utf8'))).toEqual({ $uuid: 'U2', title: 'New Title', body: '\nbody\n' })
  })

  it('is idempotent — a second projection reports unchanged', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [articleDoc('U1', 'Hello', '\n# Hi\n')]
    const o = { resolveDeclaration }

    collectionsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: o })
    const report = collectionsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: o })
    expect(report.unchanged).toEqual([join(dir, 'collections/articles/hello.md')])
    expect(report.placed).toEqual([])
  })
})

describe('collectionsToProject — folder identity + no silent skips', () => {
  it('writes the folder $uuid into collections.yml', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F7')
    collectionsToProject({ folderDoc, recordDocs: [articleDoc('U1', 'Hi', '\nx\n')], siteRoot: dir, opts: { resolveDeclaration } })

    const colYml = readFileSync(join(dir, 'collections/collections.yml'), 'utf8')
    expect(colYml).toContain('$uuid: F7')
  })

  it('skips (does not crash on) a record whose model cannot be resolved', () => {
    const folderDoc = folderFor([{ id: 'mystery/x', uuid: 'M1', slug: 'x', collection: 'mystery' }], 'F1')
    const report = collectionsToProject({
      folderDoc,
      recordDocs: [{ $uuid: 'M1', $model: '@acme/unknown', mystery: {} }],
      siteRoot: dir,
      opts: { resolveDeclaration },
    })
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]).toMatchObject({ uuid: 'M1', reason: expect.stringContaining('@acme/unknown') })
  })
})

describe('collectionsToProject — prosemirror content field (B)', () => {
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

  it('renders a PM-doc body to markdown (.md) and flushes its structural map to locales/collections', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    const recordDocs = [
      { $uuid: 'U1', $model: '@acme/article', article: { title: { en: 'Hello' }, body: { en: pmDoc, es: { 'Hello world': 'Hola mundo' } } } },
    ]

    const report = collectionsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration: resolvePm } })

    // body field (prosemirror) → markdown body in a .md file (briefHasContentBody → md format)
    const f = join(dir, 'collections/articles/hello.md')
    expect(report.placed).toContain(f)
    expect(readFileSync(f, 'utf8')).toContain('Hello world')
    // the target structural map → locales/collections/es.json by source-text hash
    const es = JSON.parse(readFileSync(join(dir, 'locales/collections/es.json'), 'utf8'))
    expect(es[computeHash('Hello world')]).toBe('Hola mundo')
  })
})

describe('collectionsToProject — localized record scalars (B)', () => {
  it('writes the source field inline and target locales to locales/collections/{locale}.json', () => {
    const folderDoc = folderFor([{ id: 'articles/hello', uuid: 'U1', slug: 'hello', collection: 'articles' }], 'F1')
    // A record with a multi-locale title scalar (and a source-only richtext body).
    const recordDocs = [
      { $uuid: 'U1', $model: '@acme/article', article: { $uuid: 'rec', title: { en: 'Hello', es: 'Hola' }, body: { en: '\nHi\n' } } },
    ]

    const report = collectionsToProject({ folderDoc, recordDocs, siteRoot: dir, opts: { resolveDeclaration } })

    // source-locale title stays inline in the record file
    const f = join(dir, 'collections/articles/hello.md')
    expect(readFileSync(f, 'utf8')).toContain('title: Hello')
    // target locale → locales/collections/es.json keyed by hash(source)
    const es = JSON.parse(readFileSync(join(dir, 'locales/collections/es.json'), 'utf8'))
    expect(es[computeHash('Hello')]).toBe('Hola')
    expect(report.locales.es).toBe('updated')
  })
})
