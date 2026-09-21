// ⭐ `draft: true` — a record that sits in the folder but is not delivered while the
// site is published (ruled 2026-09-21). The build leaves it out of what it delivers,
// and keeps it where the author previews it. `published: false`, the spelling it
// replaces, is refused by name: ignoring it would deliver every record written with it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processQueries } from '../src/site/query-processor.js'
import { isDraftRecord } from '../src/site/record-draft.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const compile = (opts) =>
  processQueries(ROOT, { posts: { name: 'posts', schema: '@/post' } }, undefined, '/', opts)
const slugs = async (opts) => (await compile(opts)).posts.map((r) => r.slug).sort()

let warn, log
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'record-draft-'))
  w('site.yml', 'name: T\n')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  log.mockRestore()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('a draft is left out of what the site delivers', () => {
  it('a markdown draft is not compiled — and its co-located image is not copied', async () => {
    w('records/post/live.md', '---\ntitle: Live\n---\n\nBody.\n')
    w('records/post/soon.md', '---\ntitle: Soon\ndraft: true\nimage: ./soon.png\n---\n\nBody.\n')
    w('records/post/soon.png', 'PNG')
    // the subject, and ⛔ CONTROL — its sibling IS delivered
    expect(await slugs()).toEqual(['live'])
    // nothing of the draft ships: `public/` is copied into the built site whole
    expect(existsSync(join(ROOT, 'public/records/post/soon.png'))).toBe(false)
  })

  it('in every format — a YAML mapping, a JSON object, and an entry of an array', async () => {
    w('records/post/a.yml', 'title: A\ndraft: true\n')
    w('records/post/b.json', '{ "title": "B", "draft": true }')
    w('records/post/list.yml', '- slug: c\n  title: C\n  draft: true\n- slug: d\n  title: D\n')
    expect(await slugs()).toEqual(['d'])
  })

  it('`draft: false` is a record like any other', async () => {
    w('records/post/a.md', '---\ntitle: A\ndraft: false\n---\n')
    expect(await slugs()).toEqual(['a'])
  })

  it('a preview keeps it — `pnpm dev` and `uniweb validate` compile with drafts', async () => {
    w('records/post/live.md', '---\ntitle: Live\n---\n')
    w('records/post/soon.md', '---\ntitle: Soon\ndraft: true\n---\n')
    expect(await slugs({ includeDrafts: true })).toEqual(['live', 'soon'])
  })
})

describe('⛔ refused by name', () => {
  it('`published: false` — naming what replaced it', async () => {
    w('records/post/old.md', '---\ntitle: Old\npublished: false\n---\n')
    await expect(compile()).rejects.toThrow(/records\/post\/old\.md: `published: false` is retired .*`draft: true`/)
    // ⛔ and on a preview too: it is the spelling that is retired, not the run
    await expect(compile({ includeDrafts: true })).rejects.toThrow(/published: false/)
  })

  it('a `draft:` that is not true or false', () => {
    expect(() => isDraftRecord({ draft: 'yes' }, 'x.md')).toThrow(/`draft:` is true or false/)
  })

  // ⛔ CONTROL — `published` stays an ordinary field: only the retired `false` is refused.
  it('CONTROL — `published: true`, or a date, is just a field', async () => {
    w('records/post/a.md', '---\ntitle: A\npublished: true\n---\n')
    w('records/post/b.md', '---\ntitle: B\npublished: 2026-01-02\n---\n')
    expect(await slugs()).toEqual(['a', 'b'])
  })
})
