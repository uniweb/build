/**
 * ⭐ A PULL OF WHAT WAS PUSHED, INTO THE COPY THAT PUSHED IT, LEAVES EVERY FILE AS THE AUTHOR WROTE IT.
 *
 * Measured 2026-09-26 on the `international` template: such a pull changed 32 files though it brought
 * nothing new — `site.yml`, `theme.yml` and each `page.yml` re-dumped (comments gone, lists reflowed,
 * strings re-quoted), each numbered section file renamed to `<id>.md` with its id written into it and a
 * `sections:` list added to recover the order the numbers had given, the translation files re-sorted by
 * hash, and each record re-rendered. A comparison of what the files MEAN found nothing; `git status`
 * found all of it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject, writeRecordFile } from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'

let DIR
afterEach(() => DIR && rmSync(DIR, { recursive: true, force: true }))

const FILES = {
  'site.yml': [
    'name: Site',
    'tags: [nonprofit, community]',
    'defaultLanguage: en',
    '',
    '# Foundation to use for this site',
    'foundation: "@acme/fnd@1.0.0"',
    '',
    '# The homepage',
    'index: home',
    '',
    'queries:',
    '  articles:',
    "    schema: '@std/article'",
    '    sort: date desc',
    '',
  ].join('\n'),
  'theme.yml': 'colors:\n  primary: "#047857"\n\nfonts:\n  body: "Inter, system-ui, sans-serif"\n',
  'pages/home/page.yml': 'title: Home\n\n# The landing page\n',
  'pages/about/page.yml': 'title: About\norder: 1\n\n# Who we are\n',
  'pages/about/1-hero.md': '---\ntype: Hero\n---\n\n# About us\n',
  'pages/about/2-story.md': '---\ntype: Section\n---\n\n## Our story\nIt began in 2008.\n',
  'pages/home/1-hero.md': '---\ntype: Hero\n---\n\n# Welcome\n',
  'layout/header.md': '---\ntype: Header\n---\n\n# Site\n',
  // No `type:` — the push sends `Content` for it, and the foundation's `defaultSection` renders it.
  'pages/home/2-notes.md': '# Notes\n\nNothing typed here.\n',
  // Page order, not hash order — the way the template keeps it.
  'locales/es.json': JSON.stringify({ [computeHash('Welcome')]: 'Bienvenidos', [computeHash('About us')]: 'Sobre nosotros' }, null, 2) + '\n',
}

function project() {
  DIR = mkdtempSync(join(tmpdir(), 'uwx-pull-leaves-'))
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(join(DIR, rel, '..'), { recursive: true })
    writeFileSync(join(DIR, rel), body)
  }
  return DIR
}

// Every file under the site, by path → bytes.
function snapshot(root) {
  const out = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '.uniweb') continue
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(root, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(root)
  return out
}

describe('pull into the copy that pushed', () => {
  it('⭐ changes no file', async () => {
    const root = project()
    const before = snapshot(root)
    const document = await siteProjectToDocument(root)
    siteContentDocumentToProject({ document, siteRoot: root, prune: true })
    expect(snapshot(root)).toEqual(before)
  })

  it('CONTROL — what did change is written, and nothing else', async () => {
    const root = project()
    const before = snapshot(root)
    const document = await siteProjectToDocument(root)
    const about = document.pages.find((p) => p.slug?.en === 'about')
    about.title = { en: 'About PandaWatch' }
    about.page_sections.reverse() // the story now comes first
    siteContentDocumentToProject({ document, siteRoot: root, prune: true })
    const after = snapshot(root)
    const changed = Object.keys(after).filter((f) => after[f] !== before[f])
    expect(changed).toEqual(['pages/about/page.yml'])
    const yml = yaml.load(after['pages/about/page.yml'])
    expect(yml.title).toBe('About PandaWatch')
    expect(yml.sections).toEqual(['story', 'hero', '...'])
  })
})

describe('a record the pull did not change', () => {
  const DECL = { sections: { article: { kind: 'single', brief: true, fields: { title: { type: 'string' }, tags: { type: 'string', many: true }, date: { type: 'date' } } } } }

  it('⭐ keeps the author’s file', () => {
    DIR = mkdtempSync(join(tmpdir(), 'uwx-pull-leaves-'))
    const filePath = join(DIR, 'post.yml')
    // As a push leaves it in a working copy: with the `$uuid` the backend gave it.
    const authored = '# A post\n$uuid: u-1\ntitle: Hello\n\ndate: 2024-01-10\ntags: [a, b]\n'
    writeFileSync(filePath, authored)
    const document = { $uuid: 'u-1', $schema: '@acme/post', article: { title: 'Hello', tags: ['a', 'b'], date: '2024-01-10' } }
    expect(writeRecordFile({ filePath, document, declaration: DECL, format: 'yaml' })).toBe('unchanged')
    expect(readFileSync(filePath, 'utf8')).toBe(authored)
  })

  it('CONTROL — one that changed is written', () => {
    DIR = mkdtempSync(join(tmpdir(), 'uwx-pull-leaves-'))
    const filePath = join(DIR, 'post.yml')
    writeFileSync(filePath, '$uuid: u-1\ntitle: Hello\ntags: [a, b]\n')
    const document = { $uuid: 'u-1', $schema: '@acme/post', article: { title: 'Hello again', tags: ['a', 'b'] } }
    expect(writeRecordFile({ filePath, document, declaration: DECL, format: 'yaml' })).toBe('updated')
    expect(yaml.load(readFileSync(filePath, 'utf8')).title).toBe('Hello again')
  })
})
