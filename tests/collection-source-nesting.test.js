// The sync lane is FLAT and the delivery lane is not, so the two disagree about
// what a collection contains. That disagreement is legitimate — the folder shape
// agreed with the entity store is one level — but its failure mode is the
// dangerous one: a nested record builds and renders locally, then is simply
// absent from the synced set. These tests pin the report that makes it visible.
import { readCollectionRecords } from '../src/uwx/collection-source.js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('collection sync — nested records are reported, never silently dropped', () => {
  let dir
  let warn

  const write = (rel, title) => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, `---\ntitle: ${title}\n---\n\nBody.\n`)
  }

  beforeEach(() => {
    dir = join(tmpdir(), `collection-source-${Date.now()}-${Math.round(performance.now())}`)
    mkdirSync(dir, { recursive: true })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  const messages = () => warn.mock.calls.map((c) => String(c[0]))

  it('syncs only the top level', async () => {
    write('hello.md', 'Top')
    write('2024/spring.md', 'Spring')
    const records = await readCollectionRecords(dir)
    expect(records.map((r) => r.slug)).toEqual(['hello'])
  })

  it('names the records it is leaving behind', async () => {
    write('hello.md', 'Top')
    write('2024/spring.md', 'Spring')
    write('2024/q1/report.md', 'Q1')
    const msg = messages().find((m) => m.includes('NOT synced'))
    expect(msg).toBeUndefined() // nothing read yet
    await readCollectionRecords(dir)
    const after = messages().find((m) => m.includes('NOT synced'))
    expect(after).toContain('2024/spring.md')
    expect(after).toContain('2024/q1/report.md')
    expect(after).toContain('2 record(s)')
  })

  it('stays silent on a flat collection', async () => {
    // The control: a warning on every sync would be noise, and would train
    // authors to stop reading exactly the message that matters.
    write('a.md', 'A')
    write('b.md', 'B')
    await readCollectionRecords(dir)
    expect(messages().filter((m) => m.includes('NOT synced'))).toHaveLength(0)
  })

  it('ignores underscore and dot directories, matching the delivery lane', async () => {
    write('a.md', 'A')
    write('_drafts/secret.md', 'Draft')
    write('.cache/x.md', 'Cached')
    await readCollectionRecords(dir)
    expect(messages().filter((m) => m.includes('NOT synced'))).toHaveLength(0)
  })

  it('does not mistake a directory named like a record for one', async () => {
    // `readdir` used to return names only, so a directory called `2024.json`
    // passed the extension filter and was read as a file.
    write('a.md', 'A')
    mkdirSync(join(dir, '2024.json'), { recursive: true })
    const records = await readCollectionRecords(dir)
    expect(records.map((r) => r.slug)).toEqual(['a'])
  })
})
