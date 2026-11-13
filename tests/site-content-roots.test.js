/**
 * ⭐ A PUSH READS THE SITE ONLY UNDER ITS CONTENT ROOTS (`siteContentRoots`, `src/uwx/site-dirs.js`).
 *
 * The roots are what the CLI checks before a push — nothing uncommitted under them — and what a pull
 * merges. A file the push read outside them would go out unchecked, as a mounted folder did until
 * 2026-11-04: the committed-content check named no mount, and its uncommitted edits were sent.
 *
 * So every file outside the roots is changed here, one at a time, and the document a push builds
 * must not move; and, as the control that lets this go red, a file under each root is changed and
 * the document must.
 */
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { siteProjectToDocument, siteContentRoots } from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'

let ROOT
const w = (rel, body) => {
  mkdirSync(join(ROOT, rel, '..'), { recursive: true })
  writeFileSync(join(ROOT, rel), body)
}
const site = () => join(ROOT, 'site')
const SITE_YML = [
  'name: Site',
  'foundation: "@acme/base@1.0.0"',
  'index: home',
  'defaultLanguage: en',
  'languages: [en, es]',
  'paths:',
  '  pages/docs: ../docs-repo',
  '',
].join('\n')

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'site-content-roots-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  w('site/site.yml', SITE_YML)
  w('site/theme.yml', 'colors:\n  primary: "#047857"\n')
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/hero.md', '# Welcome\n\nHello.\n')
  w('site/pages/docs/folder.yml', 'title: Documentation\n')
  w('site/layout/header.md', '# Site\n')
  w('site/locales/es.json', '{}\n')
  w('docs-repo/folder.yml', 'title: Docs\n')
  w('docs-repo/intro.md', '# Intro\n\nRead me first.\n')
  w('docs-repo/guide/setup.md', '# Setup\n')
  // Outside every root: the site's own notes and manifest, and a folder beside the mount.
  w('site/README.md', '# About this repository\n')
  w('site/notes/scratch.md', '# Scratch\n')
  w('site/package.json', '{ "name": "site" }\n')
  w('other-repo/page.md', '# Not mounted\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const doc = async () => JSON.stringify(await siteProjectToDocument(site()))
const underRoots = (abs, roots) => roots.some((r) => abs === r.abs || abs.startsWith(r.abs + sep))

describe('the roots of a site', () => {
  it('name every place the build reads, a mount by the segment it fills', () => {
    const roots = siteContentRoots(site(), { paths: { 'pages/docs': '../docs-repo' } })
    expect(roots.map((r) => `${r.kind}:${r.path}`)).toEqual([
      'config:site.yml', 'config:theme.yml', 'config:head.html', 'config:queries.yml',
      'translations:locales', 'pages:pages', 'layout:layout', 'records:records', 'media:public',
      'mount:../docs-repo',
    ])
    expect(roots.find((r) => r.kind === 'mount')).toMatchObject({ segment: 'docs', abs: join(ROOT, 'docs-repo') })
  })

  it("take the translations from `i18n.localesDir`, and name the files there a push never sends", () => {
    const at = (yml) => siteContentRoots(site(), yml).find((r) => r.kind === 'translations')
    expect(at({})).toMatchObject({ path: 'locales', abs: join(ROOT, 'site', 'locales') })
    expect(at({}).unsent).toEqual([
      'locales/manifest.json', 'locales/_memory.json', 'locales/records/manifest.json',
      'locales/records/_memory.json', 'locales/freeform/*/.manifest.json',
    ])
    expect(at({ i18n: { localesDir: 'translations' } })).toMatchObject({ path: 'translations', abs: join(ROOT, 'site', 'translations') })
    expect(at({ i18n: { localesDir: 'translations' } }).unsent[0]).toBe('translations/manifest.json')
  })

  it('follow `paths:` where it moves the pages, layout and records', () => {
    const roots = siteContentRoots(site(), { paths: { pages: 'content', layout: '../chrome', records: 'data/records' } })
    expect(roots.filter((r) => ['pages', 'layout', 'records'].includes(r.kind)).map((r) => r.path)).toEqual(['content', '../chrome', 'data/records'])
  })
})

describe('⭐ a push reads nothing outside the roots', () => {
  it('a file outside every root changes nothing a push sends', async () => {
    const roots = siteContentRoots(site(), { paths: { 'pages/docs': '../docs-repo' } })
    const outside = ['site/README.md', 'site/notes/scratch.md', 'site/package.json', 'other-repo/page.md']
    for (const f of outside) expect(underRoots(join(ROOT, f), roots), f).toBe(false)
    const before = await doc()
    for (const f of outside) {
      appendFileSync(join(ROOT, f), f.endsWith('.json') ? '\n' : '\nAn edit.\n')
      expect(await doc(), f).toBe(before)
    }
  })

  it("⭐ the translation tools' own files change nothing a push sends", async () => {
    const tools = ['site/locales/manifest.json', 'site/locales/_memory.json', 'site/locales/records/manifest.json', 'site/locales/freeform/es/.manifest.json']
    for (const f of tools) w(f, '{ "version": "1.0", "units": {} }\n')
    const before = await doc()
    for (const f of tools) {
      writeFileSync(join(ROOT, f), '{ "version": "1.0", "units": { "deadbeef": { "source": "Welcome" } } }\n')
      expect(await doc(), f).toBe(before)
    }
    // CONTROL: a translation beside them does move it.
    w('site/locales/es.json', JSON.stringify({ [computeHash('Welcome')]: 'Bienvenido' }) + '\n')
    expect(await doc()).not.toBe(before)
  })

  it('CONTROL — a file under each root does change it', async () => {
    const roots = siteContentRoots(site(), { paths: { 'pages/docs': '../docs-repo' } })
    const inside = ['site/site.yml', 'site/theme.yml', 'site/pages/home/hero.md', 'site/layout/header.md', 'docs-repo/intro.md', 'docs-repo/guide/setup.md']
    let last = await doc()
    for (const f of inside) {
      expect(underRoots(join(ROOT, f), roots), relative(ROOT, join(ROOT, f))).toBe(true)
      appendFileSync(join(ROOT, f), f.endsWith('.yml') ? 'description: changed\n' : '\nAn edit.\n')
      const now = await doc()
      expect(now, f).not.toBe(last)
      last = now
    }
  })
})
