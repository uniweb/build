import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  findRecordFile,
  backfillUuid,
  backfillArrayFile,
  backfillBibFile,
  renderEntityDocument,
  backfillEntityUuids,
} from '../src/uwx/index.js'
import { parseBibtex } from '@citestyle/bibtex'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-backfill-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('findRecordFile', () => {
  it('finds a single-record file by slug, probing extensions', () => {
    writeFileSync(join(dir, 'widget-x.yml'), 'title: X\n')
    expect(findRecordFile(dir, 'widget-x')).toBe(join(dir, 'widget-x.yml'))
  })
  it('returns null when no single-record file matches (e.g. array-form)', () => {
    writeFileSync(join(dir, 'all.yml'), '- slug: a\n- slug: b\n')
    expect(findRecordFile(dir, 'a')).toBeNull()
  })
})

describe('backfillUuid — YAML', () => {
  it('prepends $uuid on first sync and re-parses with fields intact', () => {
    const f = join(dir, 'widget-x.yml')
    writeFileSync(f, 'title: Widget X\nprice: 9.99\n')
    expect(backfillUuid(f, '0192-aaaa').status).toBe('updated')

    const text = readFileSync(f, 'utf8')
    expect(text.startsWith('$uuid: 0192-aaaa\n')).toBe(true)
    const parsed = yaml.load(text)
    expect(parsed.$uuid).toBe('0192-aaaa')
    expect(parsed.title).toBe('Widget X')
    expect(parsed.price).toBe(9.99)
  })

  it('replaces an existing $uuid in place on re-sync', () => {
    const f = join(dir, 'w.yml')
    writeFileSync(f, '$uuid: old-uuid\ntitle: W\n')
    expect(backfillUuid(f, 'new-uuid').status).toBe('updated')
    const parsed = yaml.load(readFileSync(f, 'utf8'))
    expect(parsed.$uuid).toBe('new-uuid')
    expect(parsed.title).toBe('W')
  })

  it('is idempotent — same $uuid leaves the file untouched', () => {
    const f = join(dir, 'w.yml')
    const original = '$uuid: same\ntitle: W\n'
    writeFileSync(f, original)
    expect(backfillUuid(f, 'same').status).toBe('unchanged')
    expect(readFileSync(f, 'utf8')).toBe(original)
  })
})

describe('backfillUuid — JSON', () => {
  it('inserts $uuid as the leading key and re-parses', () => {
    const f = join(dir, 'g.json')
    writeFileSync(f, JSON.stringify({ title: 'G', price: 1 }, null, 2) + '\n')
    expect(backfillUuid(f, '0192-bbbb').status).toBe('updated')
    const text = readFileSync(f, 'utf8')
    const parsed = JSON.parse(text)
    expect(Object.keys(parsed)[0]).toBe('$uuid')
    expect(parsed.$uuid).toBe('0192-bbbb')
    expect(parsed.title).toBe('G')
  })

  it('is idempotent for an unchanged $uuid', () => {
    const f = join(dir, 'g.json')
    writeFileSync(f, JSON.stringify({ $uuid: 'x', title: 'G' }, null, 2) + '\n')
    const before = readFileSync(f, 'utf8')
    expect(backfillUuid(f, 'x').status).toBe('unchanged')
    expect(readFileSync(f, 'utf8')).toBe(before)
  })
})

describe('backfillUuid — markdown frontmatter', () => {
  it('inserts $uuid into the frontmatter and preserves the body verbatim', () => {
    const f = join(dir, 'a.md')
    writeFileSync(f, '---\ntitle: A\n---\n\n# Heading\n\nBody text.\n')
    expect(backfillUuid(f, '0192-mmmm').status).toBe('updated')

    const text = readFileSync(f, 'utf8')
    expect(text.startsWith('---\n$uuid: 0192-mmmm\n')).toBe(true)
    // body survives untouched (no ProseMirror, no reflow)
    expect(text.endsWith('---\n\n# Heading\n\nBody text.\n')).toBe(true)
  })

  it('is idempotent on a canonical markdown file', () => {
    const f = join(dir, 'a.md')
    writeFileSync(f, '---\n$uuid: same\ntitle: A\n---\n\nBody.\n')
    const before = readFileSync(f, 'utf8')
    expect(backfillUuid(f, 'same').status).toBe('unchanged')
    expect(readFileSync(f, 'utf8')).toBe(before)
  })
})

describe('backfillUuid — deferred formats', () => {
  it('defers BibTeX', () => {
    const f = join(dir, 'a.bib')
    writeFileSync(f, '@article{a, title={A}}\n')
    expect(backfillUuid(f, 'u').status).toBe('deferred')
  })
  it('defers array-form YAML (many records in one file)', () => {
    const f = join(dir, 'all.yml')
    writeFileSync(f, '- slug: a\n- slug: b\n')
    expect(backfillUuid(f, 'u').status).toBe('deferred')
  })
})

describe('backfillArrayFile — many records in one file', () => {
  it('inserts $uuid per element keyed by slug and re-renders YAML once', () => {
    const f = join(dir, 'all.yml')
    writeFileSync(f, '- slug: a\n  name: A\n- slug: b\n  name: B\n')
    expect(backfillArrayFile(f, new Map([['a', 'u-a'], ['b', 'u-b']])).status).toBe('updated')

    const arr = yaml.load(readFileSync(f, 'utf8'))
    expect(arr.map((e) => e.$uuid)).toEqual(['u-a', 'u-b'])
    // other data preserved (only $uuid added per element)
    expect(arr.map(({ $uuid, ...rest }) => rest)).toEqual([
      { slug: 'a', name: 'A' },
      { slug: 'b', name: 'B' },
    ])
  })

  it('is idempotent — a re-run with the same uuids leaves the file untouched', () => {
    const f = join(dir, 'all.yml')
    writeFileSync(f, '- slug: a\n  name: A\n')
    backfillArrayFile(f, new Map([['a', 'u-a']]))
    const before = readFileSync(f, 'utf8')
    expect(backfillArrayFile(f, new Map([['a', 'u-a']])).status).toBe('unchanged')
    expect(readFileSync(f, 'utf8')).toBe(before)
  })

  it('leaves elements without a minted uuid untouched (JSON)', () => {
    const f = join(dir, 'all.json')
    writeFileSync(f, JSON.stringify([{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }], null, 2) + '\n')
    backfillArrayFile(f, new Map([['a', 'u-a']]))
    const arr = JSON.parse(readFileSync(f, 'utf8'))
    expect(arr[0].$uuid).toBe('u-a')
    expect(arr[1]).not.toHaveProperty('$uuid')
  })
})

describe('backfillBibFile — BibTeX', () => {
  it('inserts $uuid per entry (by cite key) and re-parses; idempotent', () => {
    const f = join(dir, 'refs.bib')
    writeFileSync(f, '@article{a, title = {A}, year = {2024}}\n@book{b, title = {B}, year = {2025}}\n')
    expect(backfillBibFile(f, new Map([['a', 'u-a'], ['b', 'u-b']])).status).toBe('updated')
    const re = parseBibtex(readFileSync(f, 'utf8'))
    expect(Object.fromEntries(re.map((e) => [e.id, e.$uuid]))).toEqual({ a: 'u-a', b: 'u-b' })
    // re-run with the same uuids is a no-op (fixpoint)
    expect(backfillBibFile(f, new Map([['a', 'u-a'], ['b', 'u-b']])).status).toBe('unchanged')
  })

  it('leaves entries without a minted uuid untouched', () => {
    const f = join(dir, 'refs.bib')
    writeFileSync(f, '@article{a, title = {A}}\n@book{b, title = {B}}\n')
    backfillBibFile(f, new Map([['a', 'u-a']]))
    const re = parseBibtex(readFileSync(f, 'utf8'))
    expect(re.find((e) => e.id === 'a').$uuid).toBe('u-a')
    expect(re.find((e) => e.id === 'b').$uuid).toBeUndefined()
  })
})

describe('renderEntityDocument — variant A (document → authoring file)', () => {
  const articleDecl = {
    name: '@acme/article',
    sections: {
      article: {
        brief: true,
        fields: {
          title: { type: 'string', localized: true },
          body: { type: 'richtext', localized: true },
        },
      },
    },
  }

  it('renders a markdown entity to frontmatter + body (richtext → body), dropping the record uuid', () => {
    const doc = {
      $uuid: 'E1',
      $model: '@acme/article',
      article: { $uuid: 'rec', title: { en: 'Hello' }, body: { en: '\n# Hi\n' } },
    }
    const text = renderEntityDocument({ document: doc, declaration: articleDecl, format: 'md' })
    expect(text).toBe('---\n$uuid: E1\ntitle: Hello\n---\n\n# Hi\n')
  })

  it('renders a yaml entity to a flat mapping (richtext stays a field; $model/$id/record-uuid dropped)', () => {
    const doc = {
      $uuid: 'E1',
      $model: '@acme/article',
      article: { $uuid: 'rec', title: { en: 'Hello' }, body: { en: 'plain text' } },
    }
    const obj = yaml.load(renderEntityDocument({ document: doc, declaration: articleDecl, format: 'yaml' }))
    expect(obj).toEqual({ $uuid: 'E1', title: 'Hello', body: 'plain text' })
  })
})

describe('backfillEntityUuids — correlate by index', () => {
  it('array-form: per-entry uuids into one file, single write, by index', () => {
    const f = join(dir, 'tags.yml')
    writeFileSync(f, '- slug: a\n  name: A\n- slug: b\n  name: B\n')
    const index = [
      { id: 'a', slug: 'a', sourceFile: f, format: 'yaml', multiRecord: true },
      { id: 'b', slug: 'b', sourceFile: f, format: 'yaml', multiRecord: true },
    ]
    const finalized = [{ index: 0, uuid: 'u-a' }, { index: 1, uuid: 'u-b' }]
    const res = backfillEntityUuids({ index, finalized })
    expect(res.updated).toEqual([f])
    expect(yaml.load(readFileSync(f, 'utf8')).map((e) => e.$uuid)).toEqual(['u-a', 'u-b'])
  })

  it('BibTeX (multiRecord): writes per-entry $uuid by cite key, one file', () => {
    const f = join(dir, 'refs.bib')
    writeFileSync(f, '@article{smith2026, title = {On Rust}, year = {2026}}\n@book{jones2025, title = {Systems}, year = {2025}}\n')
    const res = backfillEntityUuids({
      index: [
        { id: 'smith2026', slug: 'smith2026', sourceFile: f, format: 'bib', multiRecord: true },
        { id: 'jones2025', slug: 'jones2025', sourceFile: f, format: 'bib', multiRecord: true },
      ],
      finalized: [{ index: 0, uuid: 'u-smith' }, { index: 1, uuid: 'u-jones' }],
    })
    expect(res.updated).toEqual([f])
    const byId = Object.fromEntries(parseBibtex(readFileSync(f, 'utf8')).map((e) => [e.id, e.$uuid]))
    expect(byId).toEqual({ smith2026: 'u-smith', jones2025: 'u-jones' })
  })

  it('variant B: back-fills the uuid in place when there is no document', () => {
    const wx = join(dir, 'widget-x.yml')
    writeFileSync(wx, 'title: Widget X\n')
    const index = [{ id: 'widget-x', slug: 'widget-x', sourceFile: wx, format: 'yaml' }]
    const res = backfillEntityUuids({ index, finalized: [{ index: 0, uuid: '0192-aaaa' }] })
    expect(res.updated).toEqual([wx])
    expect(yaml.load(readFileSync(wx, 'utf8')).$uuid).toBe('0192-aaaa')
  })

  it('variant A: renders the finalized document over the file (entity uuid only)', () => {
    const wx = join(dir, 'widget-x.yml')
    writeFileSync(wx, 'title: Widget X\nprice: 9.99\n')
    const declaration = {
      name: '@acme/product',
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
    const index = [{ id: 'widget-x', slug: 'widget-x', sourceFile: wx, format: 'yaml', declaration }]
    const finalized = [
      {
        index: 0,
        uuid: 'E0',
        changed: true,
        document: {
          $uuid: 'E0',
          $model: '@acme/product',
          product: { $uuid: 'rec', title: { en: 'Widget X' }, price: 9.99 },
        },
      },
    ]
    const res = backfillEntityUuids({ index, finalized })
    expect(res.updated).toEqual([wx])
    const out = yaml.load(readFileSync(wx, 'utf8'))
    expect(out.$uuid).toBe('E0') // entity uuid persisted
    expect(out.title).toBe('Widget X') // localized unwrapped
    expect(out.price).toBe(9.99)
    expect(out).not.toHaveProperty('product') // not the wire shape
    expect(JSON.stringify(out)).not.toContain('rec') // brief record uuid dropped (singularity)
  })

  it('warns on a finalized index with no matching submitted entity', () => {
    const res = backfillEntityUuids({ index: [], finalized: [{ index: 7, uuid: 'u' }] })
    expect(res.updated).toHaveLength(0)
    expect(res.warnings.some((w) => w.includes('index 7'))).toBe(true)
  })

  it('reports deferred when the matched entry has no source file', () => {
    const res = backfillEntityUuids({
      index: [{ id: 'a', slug: 'a', sourceFile: null }],
      finalized: [{ index: 0, uuid: 'u' }],
    })
    expect(res.deferred).toHaveLength(1)
    expect(res.deferred[0].id).toBe('a')
  })

  it('skips finalized entries that carry no uuid', () => {
    const res = backfillEntityUuids({
      index: [{ id: 'a', slug: 'a', sourceFile: join(dir, 'a.yml'), format: 'yaml' }],
      finalized: [{ index: 0 }],
    })
    expect(res.updated).toHaveLength(0)
    expect(res.warnings).toHaveLength(0)
  })
})
