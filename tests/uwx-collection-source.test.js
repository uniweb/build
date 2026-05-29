import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCollectionRecords, parseFrontmatter } from '../src/uwx/index.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-source-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readCollectionRecords — reads source, NOT processed delivery data', () => {
  it('reads a markdown record as raw frontmatter + raw body (no ProseMirror, no derived fields)', async () => {
    writeFileSync(
      join(dir, 'hello.md'),
      '---\ntitle: Hello\nprice: 9.99\n---\n\n# Welcome\n\nThe body.\n'
    )
    const [rec] = await readCollectionRecords(dir)
    expect(rec.format).toBe('md')
    expect(rec.slug).toBe('hello')
    expect(rec.data).toEqual({ title: 'Hello', price: 9.99 })
    // body is the RAW markdown string — not converted, not excerpted.
    expect(rec.body).toBe('\n# Welcome\n\nThe body.\n')
    expect(rec.multiRecord).toBe(false)
    expect(rec.sourceFile).toBe(join(dir, 'hello.md'))
    // none of the delivery-pipeline derivations leak in
    expect(rec.data).not.toHaveProperty('excerpt')
    expect(rec.data).not.toHaveProperty('image')
    expect(rec.data).not.toHaveProperty('content')
  })

  it('honors an explicit frontmatter slug over the filename', async () => {
    writeFileSync(join(dir, 'file-name.md'), '---\nslug: real-slug\ntitle: X\n---\nbody\n')
    const [rec] = await readCollectionRecords(dir)
    expect(rec.slug).toBe('real-slug')
  })

  it('reads a single-record YAML mapping untouched, slug from filename', async () => {
    writeFileSync(join(dir, 'widget.yml'), 'title: Widget\nprice: 5\n')
    const [rec] = await readCollectionRecords(dir)
    expect(rec.format).toBe('yaml')
    expect(rec.slug).toBe('widget')
    expect(rec.data).toEqual({ title: 'Widget', price: 5 })
    expect(rec.body).toBeUndefined()
    expect(rec.multiRecord).toBe(false)
  })

  it('reads a single-record JSON object', async () => {
    writeFileSync(join(dir, 'g.json'), JSON.stringify({ title: 'G' }))
    const [rec] = await readCollectionRecords(dir)
    expect(rec.format).toBe('json')
    expect(rec.slug).toBe('g')
    expect(rec.data).toEqual({ title: 'G' })
  })

  it('reads an array-form YAML file as many multiRecord records, each its own slug', async () => {
    writeFileSync(join(dir, 'all.yml'), '- slug: a\n  title: A\n- slug: b\n  title: B\n')
    const recs = await readCollectionRecords(dir)
    expect(recs).toHaveLength(2)
    expect(recs.map((r) => r.slug)).toEqual(['a', 'b'])
    expect(recs.every((r) => r.multiRecord === true)).toBe(true)
  })

  it('reads BibTeX entries with the cite key as slug (multiRecord)', async () => {
    writeFileSync(join(dir, 'refs.bib'), '@article{smith2026, title={On Rust}, year={2026}}\n')
    const recs = await readCollectionRecords(dir)
    expect(recs).toHaveLength(1)
    expect(recs[0].slug).toBe('smith2026')
    expect(recs[0].format).toBe('bib')
    expect(recs[0].multiRecord).toBe(true)
  })

  it('skips _-prefixed files and orders records stably', async () => {
    writeFileSync(join(dir, '_draft.md'), '---\ntitle: Draft\n---\n')
    writeFileSync(join(dir, 'b.yml'), 'title: B\n')
    writeFileSync(join(dir, 'a.yml'), 'title: A\n')
    const recs = await readCollectionRecords(dir)
    expect(recs.map((r) => r.slug)).toEqual(['a', 'b'])
  })
})

describe('parseFrontmatter', () => {
  it('splits frontmatter and body on the --- delimiter', () => {
    const { frontmatter, body } = parseFrontmatter('---\ntitle: A\n---\n\nBody\n')
    expect(frontmatter).toEqual({ title: 'A' })
    expect(body).toBe('\nBody\n')
  })
  it('treats a body-only file as empty frontmatter + whole text', () => {
    const { frontmatter, body } = parseFrontmatter('# Just a body\n')
    expect(frontmatter).toEqual({})
    expect(body).toBe('# Just a body\n')
  })
})
