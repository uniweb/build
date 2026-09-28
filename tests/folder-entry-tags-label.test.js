/**
 * What `records/folder.yml` says about a record — its entry's `tags` and `label`.
 *
 * ⭐ Ruled 2026-09-27 [Diego]: a record's entry in `folder.yml` is a path, or
 * `{ path, tags?, label? }`. They are the ENTRY's, not the record's — a backend keeps them on
 * the folder entry and answers them beside the record as `$tags` and `$label`, and so does
 * the static lane. A folder takes `tags` too. A push sends them under the same keys (`tags`,
 * `label`, as backend confirmed for its `@uniweb/folder` `contents`), and a pull writes them
 * back — at the top of the folder too, the one place a record's entry is written there.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { readEntityPool } from '../src/site/entity-pool.js'
import { readRecordsConfig, resolveFolder } from '../src/site/records-config.js'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'
import { buildLocalizedRecords } from '../src/i18n/records.js'
import { buildFolderEntity } from '../src/uwx/folder.js'
import { folderToFolderYml } from '../src/uwx/records-project.js'
import { evaluateQuery } from '@uniweb/core'

let ROOT
const w = (rel, body = '---\ntitle: X\n---\n\nB\n') => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const folder = async (yml) => {
  w('records/folder.yml', yml)
  const cfg = await readRecordsConfig(ROOT)
  return resolveFolder(cfg.entries, (await readEntityPool(ROOT)).entities)
}
let log, warn
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'folder-entry-'))
  w('site.yml', 'name: T\n')
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  log.mockRestore()
  warn.mockRestore()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('folder.yml — a record\'s entry may say its tags and label', () => {
  it('inside a folder: `{ path, tags, label }` places the record and keeps what it says', async () => {
    w('records/team/ada.md')
    w('records/team/grace.md')
    const out = await folder([
      '- folder: team',
      '  records:',
      '    - team/grace.md',
      '    - path: team/ada.md',
      '      tags: [staff, featured]',
      '      label: Ada Lovelace',
      '',
    ].join('\n'))
    expect(out.errors).toEqual([])
    const [team] = out.nodes
    expect(team.$children).toEqual([
      { kind: 'ref', name: 'grace', $entityId: expect.any(String) },
      { kind: 'ref', name: 'ada', $entityId: expect.any(String), tags: ['staff', 'featured'], label: 'Ada Lovelace' },
    ])
    const ada = [...out.placements.values()].find((p) => p.slug === 'ada')
    expect(ada).toMatchObject({ path: 'team', tags: ['staff', 'featured'], label: 'Ada Lovelace' })
  })

  it('at the top, an entry that says something places the record there', async () => {
    w('records/team/ada.md')
    const out = await folder('- path: team/ada.md\n  tags: staff\n')
    expect(out.errors).toEqual([])
    expect(out.nodes).toEqual([{ kind: 'ref', name: 'ada', $entityId: expect.any(String), tags: ['staff'] }])
  })

  it('a pattern gives every record it matches the same tags', async () => {
    w('records/team/ada.md')
    w('records/team/grace.md')
    const out = await folder('- folder: team\n  records:\n    - path: team/*.md\n      tags: [staff]\n')
    expect(out.nodes[0].$children.map((n) => [n.name, n.tags])).toEqual([['ada', ['staff']], ['grace', ['staff']]])
  })

  it('YAML numbers are text: `tags: [2024]` and `label: 2024`', async () => {
    w('records/team/ada.md')
    const out = await folder('- folder: team\n  records:\n    - path: team/ada.md\n      tags: [2024]\n      label: 2024\n')
    expect(out.nodes[0].$children[0]).toMatchObject({ tags: ['2024'], label: '2024' })
  })

  it('a folder takes `tags:` too', async () => {
    w('records/team/ada.md')
    const out = await folder('- folder: team\n  label: The team\n  tags: [people]\n  records:\n    - team/ada.md\n')
    expect(out.errors).toEqual([])
    expect(out.nodes[0]).toMatchObject({ kind: 'branch', name: 'team', label: 'The team', tags: ['people'] })
  })

  it('refuses an entry at the top that says nothing, as it refuses a bare path there', async () => {
    w('records/team/ada.md')
    expect((await folder('- path: team/ada.md\n')).errors.join('\n')).toMatch(/at the top level and says nothing about it/)
    expect((await folder('- team/ada.md\n')).errors.join('\n')).toMatch(/lists records at the top level/)
  })

  it('refuses a tag or a label that is not text, and a key a record\'s entry does not take', async () => {
    w('records/team/ada.md')
    const nested = (line) => `- folder: team\n  records:\n    - path: team/ada.md\n      ${line}\n`
    expect((await folder(nested('tags: [{ a: 1 }]'))).errors.join('\n')).toMatch(/a tag that is not text/)
    // ⭐ One text per language IS a label (2026-09-28); a list, or a language given no text, is not.
    expect((await folder(nested('label: { en: Ada, fr: Ada }'))).errors).toEqual([])
    expect((await folder(nested('label: [Ada]'))).errors.join('\n')).toMatch(/`label:` that is neither a text nor one text per language/)
    expect((await folder(nested('label: { en: [Ada] }'))).errors.join('\n')).toMatch(/`label:` that gives `en` something that is not text/)
    expect((await folder(nested('records: []'))).errors.join('\n')).toMatch(/takes `tags:` and `label:` — not `records:`/)
  })

  it('CONTROL — a record placed twice, once with tags, is still placed twice', async () => {
    w('records/team/ada.md')
    const out = await folder('- folder: team\n  records:\n    - team/ada.md\n    - path: team/ada.md\n      tags: [x]\n')
    expect(out.errors.join('\n')).toMatch(/is placed twice/)
  })
})

describe('the static lane answers them as `$tags` and `$label`', () => {
  it('in the list and in the record\'s own file; absent where the entry says none', async () => {
    w('records/team/ada.md', '---\ntitle: Ada\n---\n\nB\n')
    w('records/team/grace.md', '---\ntitle: Grace\n---\n\nB\n')
    w('records/folder.yml', '- folder: team\n  records:\n    - path: team/ada.md\n      tags: [staff, featured]\n      label: Ada Lovelace\n    - team/grace.md\n')
    const queries = { team: { name: 'team', schema: '@/team' } }
    await writeQueryFiles(ROOT, await processQueries(ROOT, queries, undefined, '/'), queries)

    const list = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'team.json'), 'utf8'))
    const ada = list.find((r) => r.$name === 'ada')
    const grace = list.find((r) => r.$name === 'grace')
    expect(ada).toMatchObject({ $tags: ['staff', 'featured'], $label: 'Ada Lovelace' })
    expect(grace).not.toHaveProperty('$tags')
    expect(grace).not.toHaveProperty('$label')

    const own = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'team', 'ada.json'), 'utf8'))
    expect(own).toMatchObject({ $tags: ['staff', 'featured'], $label: 'Ada Lovelace' })

    // A query asks for them as for any other key, and they reach the component.
    const tagged = evaluateQuery(list, { where: { $tags: 'staff' } })
    expect(tagged.map((r) => [r.$name, r.$label])).toEqual([['ada', 'Ada Lovelace']])
  })
})

describe('⭐ a label given per language is answered per language (2026-09-28)', () => {
  // One text per language in `records/folder.yml`: the site's own language answers in the data it
  // compiles; every other language in its own files — the language, its base, then the site's.
  // A language the label holds nothing of answers no `$label`, as a records service does.
  const setup = async () => {
    w('queries.yml', 'team:\n  schema: "@/team"\n')
    w('records/team/ada.md', '---\ntitle: Ada\n---\n\nB\n')
    w('records/team/grace.md', '---\ntitle: Grace\n---\n\nB\n')
    w(
      'records/folder.yml',
      '- folder: team\n  records:\n' +
        '    - path: team/ada.md\n      label: { en: Ada Lovelace, fr: Ada (fr) }\n' +
        '    - path: team/grace.md\n      label: { fr: Grace (fr) }\n'
    )
    const queries = { team: { name: 'team', schema: '@/team' } }
    await writeQueryFiles(ROOT, await processQueries(ROOT, queries, undefined, '/', { locale: 'en' }), queries)
    await buildLocalizedRecords(ROOT, { locales: ['fr', 'fr-CA', 'es'], outputDir: join(ROOT, 'dist') })
  }
  const labelsIn = (rel) =>
    Object.fromEntries(JSON.parse(readFileSync(join(ROOT, rel), 'utf8')).map((r) => [r.$name, r.$label ?? null]))
  const ownLabel = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')).$label ?? null

  it('the site’s own language, in the data it compiles', async () => {
    await setup()
    expect(labelsIn('public/data/team.json')).toEqual({ ada: 'Ada Lovelace', grace: null })
    expect(ownLabel('public/data/team/ada.json')).toBe('Ada Lovelace')
  })

  it('each other language, in its list and in each record’s own file', async () => {
    await setup()
    expect(labelsIn('dist/fr/data/team.json')).toEqual({ ada: 'Ada (fr)', grace: 'Grace (fr)' })
    expect(ownLabel('dist/fr/data/team/ada.json')).toBe('Ada (fr)')
    expect(ownLabel('dist/fr/data/team/grace.json')).toBe('Grace (fr)')
    // its base language, then the site's
    expect(labelsIn('dist/fr-CA/data/team.json')).toEqual({ ada: 'Ada (fr)', grace: 'Grace (fr)' })
    expect(labelsIn('dist/es/data/team.json')).toEqual({ ada: 'Ada Lovelace', grace: null })
  })
})

describe('a push sends them, and a pull writes them back', () => {
  const rec = (slug, uuid) => ({ id: `team/${slug}`, slug, uuid, model: '@acme/member' })

  it('the folder a push sends carries `label` (a locale map) and `tags` on the entries that say them', () => {
    const folderDoc = buildFolderEntity({
      recordEntities: [rec('ada', 'U1'), rec('grace', 'U2')],
      folderNodes: [
        { kind: 'branch', name: 'team', tags: ['people'], $children: [
          { kind: 'ref', $entityId: 'team/ada', tags: ['staff', 'featured'], label: 'Ada Lovelace' },
          { kind: 'ref', $entityId: 'team/grace' },
        ] },
      ],
      sourceLocale: 'en',
    }).document
    const [team] = folderDoc.contents
    expect(team).toMatchObject({ kind: 'branch', name: 'team', tags: ['people'] })
    expect(team.$children[0]).toEqual({
      kind: 'ref', name: 'ada', entry: { schema: '@acme/member', entity: 'U1' },
      label: { en: 'Ada Lovelace' }, tags: ['staff', 'featured'],
    })
    expect(team.$children[1]).toEqual({ kind: 'ref', name: 'grace', entry: { schema: '@acme/member', entity: 'U2' } })
  })

  it('a pull writes `{ path, tags, label }` wherever the folder says them — at the top too', () => {
    const folderDoc = {
      contents: [
        { kind: 'branch', name: 'team', tags: ['people'], $children: [
          { kind: 'ref', name: 'ada', entry: { entity: 'U1' }, tags: ['staff', 'featured'], label: { en: 'Ada Lovelace', fr: 'Ada' } },
          { kind: 'ref', name: 'grace', entry: { entity: 'U2' } },
        ] },
        { kind: 'ref', name: 'welcome', entry: { entity: 'U3' }, label: 'Welcome' },
        { kind: 'ref', name: 'plain', entry: { entity: 'U4' } },
      ],
    }
    const poolPathByUuid = new Map([['U1', 'team/ada.md'], ['U2', 'team/grace.md'], ['U3', 'news/welcome.md'], ['U4', 'news/plain.md']])
    const report = folderToFolderYml({ folderDoc, siteRoot: ROOT, poolPathByUuid, sourceLocale: 'en' })
    expect(report.warnings).toEqual([])
    expect(yaml.load(readFileSync(join(ROOT, 'records', 'folder.yml'), 'utf8'))).toEqual([
      { folder: 'team', tags: ['people'], records: [
        // ⭐ Every language the label holds, the source language first (2026-09-28) — the
        // source language's alone until then, so a translated label lost the rest.
        { path: 'team/ada.md', tags: ['staff', 'featured'], label: { en: 'Ada Lovelace', fr: 'Ada' } },
        'team/grace.md',
      ] },
      { path: 'news/welcome.md', label: 'Welcome' },
    ])
  })

  it('round-trips: what folder.yml says, a push sends, and a pull writes back the same', async () => {
    w('records/team/ada.md')
    w('records/news/welcome.md')
    const written = [
      { folder: 'team', tags: ['people'], records: [{ path: 'team/ada.md', tags: ['staff'], label: 'Ada' }] },
      { path: 'news/welcome.md', tags: ['pinned'] },
    ]
    const out = await folder(yaml.dump(written))
    expect(out.errors).toEqual([])
    const entities = [...out.placements.values()].map(({ entity, slug }, i) => ({ id: entity.id, slug, uuid: `U${i}`, model: '@acme/x' }))
    const sent = buildFolderEntity({ recordEntities: entities, folderNodes: out.nodes, sourceLocale: 'en' }).document
    const poolPathByUuid = new Map([...out.placements.values()].map(({ entity }, i) => [`U${i}`, entity.poolPath]))
    folderToFolderYml({ folderDoc: sent, siteRoot: ROOT, poolPathByUuid, sourceLocale: 'en' })
    expect(yaml.load(readFileSync(join(ROOT, 'records', 'folder.yml'), 'utf8'))).toEqual(written)
  })

  it('⭐ round-trips a label in several languages — a folder’s and a record entry’s (2026-09-28)', async () => {
    w('records/team/ada.md')
    w('records/news/welcome.md')
    const written = [
      { folder: 'team', label: { en: 'Team', fr: 'Équipe' }, records: [{ path: 'team/ada.md', label: { en: 'Ada Lovelace', fr: 'Ada (fr)' } }] },
      { path: 'news/welcome.md', label: 'Welcome' },
    ]
    const out = await folder(yaml.dump(written))
    expect(out.errors).toEqual([])
    const entities = [...out.placements.values()].map(({ entity, slug }, i) => ({ id: entity.id, slug, uuid: `U${i}`, model: '@acme/x' }))
    const sent = buildFolderEntity({ recordEntities: entities, folderNodes: out.nodes, sourceLocale: 'en' }).document
    // the wire carries every language as written, and one text as the source language's
    expect(sent.contents[0].label).toEqual({ en: 'Team', fr: 'Équipe' })
    expect(sent.contents[0].$children[0].label).toEqual({ en: 'Ada Lovelace', fr: 'Ada (fr)' })
    expect(sent.contents[1].label).toEqual({ en: 'Welcome' })
    const poolPathByUuid = new Map([...out.placements.values()].map(({ entity }, i) => [`U${i}`, entity.poolPath]))
    folderToFolderYml({ folderDoc: sent, siteRoot: ROOT, poolPathByUuid, sourceLocale: 'en' })
    expect(yaml.load(readFileSync(join(ROOT, 'records', 'folder.yml'), 'utf8'))).toEqual(written)
  })
})
