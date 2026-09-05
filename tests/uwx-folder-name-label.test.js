/**
 * The folder entry is `{ name, label }` — the store's names since 2026-09-04.
 *
 * `name` is the handle (the URL segment, sibling-unique, the door's `$name`);
 * `label` is a branch's display text, a localized map on the wire. The emitter
 * writes the new shape only and the pull reader reads the new shape only: the
 * retired `path_segment` is neither written nor read, because its presence was
 * the version signal and there is no population to carry.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFolderEntity, collectFolderItemUuids } from '../src/uwx/folder.js'
import { folderToRecordsYml } from '../src/uwx/records-project.js'

const rec = (dir, slug, uuid = null) => ({ id: `${dir}/${slug}`, slug, uuid, model: '@acme/x' })

describe('the emitter writes { name, label }', () => {
  it('a leaf carries `name` (the handle) and a branch `name` + a localized `label`', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello', 'u-1')],
      folderNodes: [{ kind: 'branch', name: 'blog', label: 'Blog', $children: [{ kind: 'ref', $entityId: 'articles/hello' }] }],
      sourceLocale: 'fr',
    })
    const [blog] = folder.document.contents
    expect(blog).toMatchObject({ kind: 'branch', name: 'blog', label: { fr: 'Blog' } })
    expect(blog.$children[0]).toEqual({ kind: 'ref', name: 'hello', entry: { model: '@acme/x', entity: 'u-1' } })
    expect(JSON.stringify(folder.document)).not.toContain('path_segment')
  })

  it('a branch with no label carries no `label` key at all', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello')],
      folderNodes: [{ kind: 'branch', name: 'blog', $children: [{ kind: 'ref', $entityId: 'articles/hello' }] }],
    })
    expect(folder.document.contents[0]).not.toHaveProperty('label')
  })

  it('placement identity is harvested by the `name` chain', () => {
    const stored = { contents: [{ kind: 'branch', name: 'team', $uuid: 'B1', $children: [{ kind: 'ref', name: 'ada', $uuid: 'I1' }] }] }
    expect(collectFolderItemUuids(stored)).toEqual({ team: 'B1', 'team/ada': 'I1' })
    // the retired key harvests NOTHING — a pull never carries it, and a document
    // that did would come from a producer older than the store's rename
    expect(collectFolderItemUuids({ contents: [{ kind: 'ref', path_segment: 'ada', $uuid: 'I1' }] })).toEqual({})
  })
})

describe('the pull reader reads { name, label }', () => {
  let root
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-folder-'))
    mkdirSync(join(root, 'entities', 'article'), { recursive: true })
    writeFileSync(join(root, 'entities', 'article', 'hello.md'), '---\ntitle: Hello\n---\n\nHi\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('writes records.yml from `name`, and unwraps a localized `label` to the source-locale string', () => {
    const folderDoc = {
      contents: [
        { kind: 'branch', name: 'blog', label: { fr: 'Le blog', en: 'Blog' }, $children: [
          { kind: 'ref', name: 'hello', entry: { model: '@acme/article', entity: 'U1' } },
        ] },
      ],
    }
    const poolPathByUuid = new Map([['U1', 'article/hello.md']])
    const report = folderToRecordsYml({ folderDoc, siteRoot: root, poolPathByUuid, sourceLocale: 'fr' })
    expect(report.warnings).toEqual([])
    const yml = readFileSync(join(root, 'records.yml'), 'utf8')
    expect(yml).toContain('folder: blog')
    expect(yml).toContain('label: Le blog')
    expect(yml).not.toContain('path_segment')
  })

  it('a bare-string label passes through unchanged', () => {
    const folderDoc = { contents: [{ kind: 'branch', name: 'blog', label: 'Blog', $children: [
      { kind: 'ref', name: 'hello', entry: { model: '@acme/article', entity: 'U1' } } ] }] }
    const poolPathByUuid = new Map([['U1', 'article/hello.md']])
    folderToRecordsYml({ folderDoc, siteRoot: root, poolPathByUuid })
    expect(readFileSync(join(root, 'records.yml'), 'utf8')).toContain('label: Blog')
  })
})
