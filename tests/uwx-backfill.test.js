import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  findRecordFile,
  backfillUuid,
  backfillArrayFile,
  backfillEntityUuids,
} from '../src/uwx/index.js'

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

describe('backfillEntityUuids — array-form (multiRecord) routing', () => {
  it('writes per-entry uuids into one array file (single file write, not per record)', () => {
    const f = join(dir, 'tags.yml')
    writeFileSync(f, '- slug: a\n  name: A\n- slug: b\n  name: B\n')
    const index = [
      { id: 'a', model: '@acme/tag', slug: 'a', sourceFile: f, format: 'yaml', multiRecord: true },
      { id: 'b', model: '@acme/tag', slug: 'b', sourceFile: f, format: 'yaml', multiRecord: true },
    ]
    const finalized = [
      { $id: 'a', $model: '@acme/tag', $uuid: 'u-a' },
      { $id: 'b', $model: '@acme/tag', $uuid: 'u-b' },
    ]
    const res = backfillEntityUuids({ index, finalized })
    expect(res.updated).toEqual([f]) // one write covers both records
    const arr = yaml.load(readFileSync(f, 'utf8'))
    expect(arr.map((e) => e.$uuid)).toEqual(['u-a', 'u-b'])
  })

  it('defers BibTeX (multiRecord, format bib)', () => {
    const f = join(dir, 'refs.bib')
    writeFileSync(f, '@article{a, title={A}}\n')
    const res = backfillEntityUuids({
      index: [{ id: 'a', model: '@acme/ref', slug: 'a', sourceFile: f, format: 'bib', multiRecord: true }],
      finalized: [{ $id: 'a', $model: '@acme/ref', $uuid: 'u' }],
    })
    expect(res.deferred).toHaveLength(1)
    expect(res.deferred[0].reason).toMatch(/BibTeX/)
  })
})

describe('backfillEntityUuids — correlate finalized → source files', () => {
  it('writes each minted uuid into the file matched by ($model, $id)', () => {
    const wx = join(dir, 'widget-x.yml')
    const gy = join(dir, 'gadget-y.yml')
    writeFileSync(wx, 'title: Widget X\n')
    writeFileSync(gy, 'title: Gadget Y\n')

    const index = [
      { id: 'widget-x', model: '@acme/product', slug: 'widget-x', sourceFile: wx },
      { id: 'gadget-y', model: '@acme/product', slug: 'gadget-y', sourceFile: gy },
    ]
    const finalized = [
      { $id: 'widget-x', $model: '@acme/product', $uuid: '0192-aaaa' },
      { $id: 'gadget-y', $model: '@acme/product', $uuid: '0192-bbbb' },
    ]
    const res = backfillEntityUuids({ index, finalized })
    expect(res.updated).toHaveLength(2)
    expect(yaml.load(readFileSync(wx, 'utf8')).$uuid).toBe('0192-aaaa')
    expect(yaml.load(readFileSync(gy, 'utf8')).$uuid).toBe('0192-bbbb')
  })

  it('warns on a finalized entity with no matching submitted record', () => {
    const res = backfillEntityUuids({
      index: [],
      finalized: [{ $id: 'ghost', $model: '@acme/product', $uuid: 'u' }],
    })
    expect(res.updated).toHaveLength(0)
    expect(res.warnings.some((w) => w.includes('ghost'))).toBe(true)
  })

  it('reports deferred when the matched record has no single-record source file', () => {
    const res = backfillEntityUuids({
      index: [{ id: 'a', model: '@acme/product', slug: 'a', sourceFile: null }],
      finalized: [{ $id: 'a', $model: '@acme/product', $uuid: 'u' }],
    })
    expect(res.deferred).toHaveLength(1)
    expect(res.deferred[0].id).toBe('a')
  })

  it('skips finalized entities that carry no $uuid', () => {
    const res = backfillEntityUuids({
      index: [{ id: 'a', model: '@acme/product', slug: 'a', sourceFile: join(dir, 'a.yml') }],
      finalized: [{ $id: 'a', $model: '@acme/product' }],
    })
    expect(res.updated).toHaveLength(0)
    expect(res.warnings).toHaveLength(0)
  })
})
