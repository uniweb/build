// Project-writer primitives (pull-side file projection, P0).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  writeIfChanged,
  resolveSectionFile,
  resolveSectionDir,
  resolveSectionPath,
  writeSectionFile,
  writeSiteConfig,
  writeThemeFile,
  writeRecordFile,
} from '../src/uwx/index.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-project-writer-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('writeIfChanged', () => {
  it('writes a new file and creates parent directories', () => {
    const f = join(dir, 'nested/deep/page.yml')
    expect(writeIfChanged(f, 'a: 1\n')).toBe('updated')
    expect(readFileSync(f, 'utf8')).toBe('a: 1\n')
  })

  it('is idempotent — an identical re-write is unchanged and leaves no tmp files', () => {
    const f = join(dir, 'page.yml')
    writeIfChanged(f, 'a: 1\n')
    expect(writeIfChanged(f, 'a: 1\n')).toBe('unchanged')
    // the atomic rename leaves no stray .tmp files behind
    expect(readdirSync(dir).some((e) => e.endsWith('.tmp'))).toBe(false)
  })

  it('detects a real change', () => {
    const f = join(dir, 'page.yml')
    writeIfChanged(f, 'a: 1\n')
    expect(writeIfChanged(f, 'a: 2\n')).toBe('updated')
    expect(readFileSync(f, 'utf8')).toBe('a: 2\n')
  })
})

describe('resolveSectionFile', () => {
  it('matches a bare, @-prefixed, numeric-prefixed, and combined filename', () => {
    writeFileSync(join(dir, 'hero.md'), '')
    writeFileSync(join(dir, '@card.md'), '')
    writeFileSync(join(dir, '2-feature.md'), '')
    writeFileSync(join(dir, '@3-aside.md'), '')

    expect(resolveSectionFile(dir, 'hero')).toBe(join(dir, 'hero.md'))
    expect(resolveSectionFile(dir, 'card')).toBe(join(dir, '@card.md'))
    expect(resolveSectionFile(dir, 'feature')).toBe(join(dir, '2-feature.md'))
    expect(resolveSectionFile(dir, 'aside')).toBe(join(dir, '@3-aside.md'))
  })

  it('returns null for no match or a missing directory', () => {
    writeFileSync(join(dir, 'hero.md'), '')
    expect(resolveSectionFile(dir, 'nope')).toBeNull()
    expect(resolveSectionFile(join(dir, 'missing'), 'hero')).toBeNull()
  })
})

describe('resolveSectionDir / resolveSectionPath', () => {
  it('maps a route to its directory via the page sourcePath, honoring path overrides', () => {
    const siteContent = {
      config: { paths: { pages: 'content/pages' } },
      pages: [{ route: '/', sourcePath: '/home' }],
    }
    const expected = join(dir, 'content/pages', 'home')
    expect(resolveSectionDir(dir, siteContent, '/', null)).toBe(expected)

    mkdirSync(expected, { recursive: true })
    writeFileSync(join(expected, '1-hero.md'), '')
    expect(resolveSectionPath(dir, siteContent, '/', null, 'hero')).toBe(join(expected, '1-hero.md'))
  })

  it('resolves a layout area directory', () => {
    const siteContent = { config: {}, pages: [] }
    const headerDir = join(dir, 'layout', 'header')
    mkdirSync(headerDir, { recursive: true })
    expect(resolveSectionDir(dir, siteContent, null, 'header')).toBe(headerDir)
  })
})

describe('writeSectionFile', () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] }

  it('writes a new section file with frontmatter + body', () => {
    const f = join(dir, 'hero.md')
    expect(writeSectionFile({ filePath: f, content, params: { type: 'Hero', align: 'center' } })).toBe('updated')
    const { frontmatter, body } = splitFile(readFileSync(f, 'utf8'))
    expect(frontmatter).toEqual({ type: 'Hero', align: 'center' })
    expect(body.trim()).toBe('Hello world')
  })

  it('preserves reserved framework keys against incoming params', () => {
    const f = join(dir, 'hero.md')
    writeFileSync(f, '---\ntype: Hero\nnest:\n  - "@card"\nalign: left\n---\n\nOld body\n')
    // Incoming params try to overwrite `type`/`nest` (reserved) and change align.
    writeSectionFile({ filePath: f, content, params: { type: 'Evil', nest: [], align: 'center' } })
    const { frontmatter } = splitFile(readFileSync(f, 'utf8'))
    expect(frontmatter.type).toBe('Hero') // reserved — not overwritten
    expect(frontmatter.nest).toEqual(['@card']) // reserved — not overwritten
    expect(frontmatter.align).toBe('center') // non-reserved param applied
  })

  it('keeps the existing body on a params-only update (no content)', () => {
    const f = join(dir, 'hero.md')
    writeFileSync(f, '---\ntype: Hero\n---\n\nKeep me\n')
    writeSectionFile({ filePath: f, params: { align: 'center' } })
    const { body } = splitFile(readFileSync(f, 'utf8'))
    expect(body.trim()).toBe('Keep me')
  })

  it('is idempotent', () => {
    const f = join(dir, 'hero.md')
    writeSectionFile({ filePath: f, content, params: { type: 'Hero' } })
    expect(writeSectionFile({ filePath: f, content, params: { type: 'Hero' } })).toBe('unchanged')
  })
})

describe('writeSiteConfig / writeThemeFile', () => {
  it('merges into site.yml, preserving untouched keys and deleting on null', () => {
    writeFileSync(join(dir, 'site.yml'), "foundation: '@acme/base'\nbase: /docs/\nname: Old\n")
    writeSiteConfig(dir, { name: 'New', base: null, languages: ['en', 'fr'] })
    const obj = yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))
    expect(obj).toEqual({ foundation: '@acme/base', name: 'New', languages: ['en', 'fr'] })
  })

  it('shallow-merges an object value one level deep (theme.yml)', () => {
    writeFileSync(join(dir, 'theme.yml'), 'vars:\n  header-height: 4rem\n  accent: blue\n')
    writeThemeFile(dir, { vars: { accent: 'red' }, mode: 'dark' })
    const obj = yaml.load(readFileSync(join(dir, 'theme.yml'), 'utf8'))
    expect(obj).toEqual({ vars: { 'header-height': '4rem', accent: 'red' }, mode: 'dark' })
  })

  it('creates the file when absent', () => {
    expect(existsSync(join(dir, 'site.yml'))).toBe(false)
    writeSiteConfig(dir, { name: 'Fresh' })
    expect(yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))).toEqual({ name: 'Fresh' })
  })
})

describe('writeRecordFile', () => {
  const declaration = {
    name: '@acme/article',
    sections: {
      article: {
        brief: true,
        fields: {
          title: { type: 'string', localized: true },
          body: { type: 'text', format: 'markdown', localized: true },
        },
      },
    },
  }
  const document = { $uuid: 'E1', $model: '@acme/article', article: { $uuid: 'rec', title: { en: 'Hello' }, body: { en: '\n# Hi\n' } } }

  it('renders and writes a markdown record, idempotently', () => {
    const f = join(dir, 'collections/articles/hello.md')
    expect(writeRecordFile({ filePath: f, document, declaration, format: 'md' })).toBe('updated')
    expect(readFileSync(f, 'utf8')).toBe('---\n$uuid: E1\ntitle: Hello\n---\n\n# Hi\n')
    expect(writeRecordFile({ filePath: f, document, declaration, format: 'md' })).toBe('unchanged')
  })
})

// Minimal frontmatter splitter for assertions (independent of the writer).
function splitFile(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return { frontmatter: {}, body: text }
  return { frontmatter: yaml.load(m[1]) || {}, body: m[2] }
}
