// ⭐ A build notes each record a push cannot carry, one line per file, and delivers it without what
// its schema has no place for, as a host delivers it: one shape on both lanes [Diego, 2026-11-11]
// (`query-processor.js::noteUnsendable`, `deliverRecord`). `uniweb validate` asks for no note: it
// reports the same records itself.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { processQueries } from '../src/site/query-processor.js'

let root
let siteRoot

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

const QUERIES = { members: { schema: '@/member' }, quotes: { schema: '@std/testimonial' } }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-unsendable-note-'))
  const foundationPath = join(root, 'foundation')
  siteRoot = join(root, 'site')
  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundationPath, 'main.js'), "export default { name: '@acme/site-kit' }\n")
  write(join(foundationPath, 'schemas', 'member.yml'), 'name: member\nfields:\n  name: { type: string, required: true }\n')
  write(join(siteRoot, 'site.yml'), 'name: fixture\nfoundation: foundation\n')
  write(join(siteRoot, 'records', 'member', 'ada.yml'), 'name: Ada\norder: 3\n')
  write(join(siteRoot, 'records', 'member', 'bob.yml'), 'name: Bob\n')
  write(join(siteRoot, 'records', 'std', 'testimonial', 'claude.md'), '---\nquote: It just works.\nname: Claude\nlogo: claude.svg\n---\n')
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

async function run(options) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const byQuery = await processQueries(siteRoot, QUERIES, 'records', '/', options)
    return { byQuery, notes: warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.startsWith('[records]')) }
  } finally {
    warn.mockRestore()
    log.mockRestore()
  }
}

describe('a build notes what a push cannot carry', () => {
  it('one line per file, with what to do for whose type it is, and the record delivered without it', async () => {
    const { byQuery, notes } = await run({})
    expect(notes).toEqual([
      '[records] records/member/ada.yml: "order" is not a field of @/member, so the site leaves it out, as a host ' +
        'does, and a push refuses it. Declare it in the schema, or remove it.',
      '[records] records/std/testimonial/claude.md: "logo" is not a field of @std/testimonial, so the site leaves ' +
        'it out, as a host does, and a push refuses it. @std/testimonial is a standard type, and a site cannot add a ' +
        'field to it. It has quote, name, context, avatar, rating, date and url: move the value into one of those, ' +
        'remove it, or give these records a type of your own (`schemas/<name>.yml` in the foundation, the records ' +
        'in `records/<name>/`).',
    ])
    const ada = byQuery.members.find((r) => r.$name === 'ada')
    expect(ada.name).toBe('Ada')
    expect(ada).not.toHaveProperty('order')
    expect(byQuery.quotes[0]).not.toHaveProperty('logo')
  })

  it('says nothing when asked not to — `uniweb validate` reports these itself', async () => {
    expect((await run({ noteUnsendable: false })).notes).toEqual([])
  })
})
