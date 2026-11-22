/**
 * ⭐ THE WORDS A SECTION DRAWS THAT ITS CONTENT DOESN'T HOLD (`i18n/words.js`). A section type's own
 * words are a data key it declares with an inline field map, each word a field's `default:`, and a
 * section that leaves the block out shows those defaults on every language's page: only what a
 * section holds is translated. `uniweb i18n words` names those sections, and writes the defaults in
 * as a block, where the parser reads it as the section's own.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { parseContent } from '@uniweb/semantic-parser'
import { wordsOf, sectionsMissingWords, withWords, routeOfSection } from '../../src/i18n/words.js'
import { parseFrontmatter } from '../../src/utils/frontmatter.js'

let ROOT, SITE
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const LABELS = "{ search: { type: 'string', default: 'Search…' }, empty: { type: 'string', default: 'No results' }, count: 'number' }"

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uw-section-words-'))
  SITE = join(ROOT, 'site')
  w('site/site.yml', 'name: T\nfoundation: fnd\nindex: home\nlanguages: [en, fr]\ni18n:\n  exclude: [/docs]\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  const section = (name, meta) => {
    w(`fdn/sections/${name}/meta.js`, `export default ${meta}\n`)
    w(`fdn/sections/${name}/index.jsx`, `export default function ${name}() { return null }\n`)
  }
  section('Catalog', `{ title: 'Catalog', data: { labels: ${LABELS} } }`)
  section('Signup', "{ title: 'Signup', data: { form: { fields: [{ id: 'email', type: 'text', default: 'you@example.com' }] } } }")
  section('Plain', "{ title: 'Plain' }")

  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/1-catalog.md', '---\ntype: Catalog\n---\n\n# Our solutions\n\nFind one.\n')
  w('site/pages/home/2-partial.md', '---\ntype: Catalog\n---\n\n# Partial\n\n```yaml:labels\nsearch: Search solutions…\n```\n')
  w('site/pages/home/3-whole.md', '---\ntype: Catalog\n---\n\n# Whole\n\n```yaml:labels\nsearch: Find\nempty: Nothing\n```\n')
  w('site/pages/home/4-signup.md', '---\ntype: Signup\n---\n\n# Sign up\n')
  w('site/pages/home/5-plain.md', '---\ntype: Plain\n---\n\n# Plain\n')
  w('site/pages/docs/page.yml', 'title: Docs\n')
  w('site/pages/docs/1-catalog.md', '---\ntype: Catalog\n---\n\n# Docs\n')
  w('site/pages/2-blog/folder.yml', 'title: Blog\n')
  w('site/pages/2-blog/1-first-post.md', '---\ntype: Catalog\n---\n\n# A post\n')
  w('site/layout/header.md', '---\ntype: Catalog\n---\n\n# Acme\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('wordsOf — the words a declaration gives', () => {
  it('an inline field map: each string field with a default', () => {
    expect(wordsOf({ search: { type: 'string', default: 'Search…' }, n: 'number', bare: 'string' })).toEqual([{ name: 'search', text: 'Search…' }])
  })

  it('none from a form, a record type, a concept block, a key with no shape, or a word kept as it is', () => {
    expect(wordsOf({ fields: [{ id: 'email', type: 'text', default: 'x' }] })).toBeNull()
    expect(wordsOf('@/member')).toBeNull()
    expect(wordsOf('Questions and answers')).toBeNull()
    expect(wordsOf({})).toBeNull()
    expect(wordsOf({ code: { type: 'string', default: 'ACME', translatable: false } })).toBeNull()
  })
})

describe('sectionsMissingWords — which sections show the foundation’s words in every language', () => {
  it('names a section with no block, and one whose block leaves words out, by its file', async () => {
    const found = await sectionsMissingWords(SITE)
    const byFile = Object.fromEntries(found.map((f) => [f.file, f]))
    expect(byFile['pages/home/1-catalog.md']).toEqual({
      file: 'pages/home/1-catalog.md', route: '/', type: 'Catalog', key: 'labels', hasBlock: false,
      words: [{ name: 'search', text: 'Search…' }, { name: 'empty', text: 'No results' }],
    })
    expect(byFile['pages/home/2-partial.md']).toMatchObject({ hasBlock: true, words: [{ name: 'empty', text: 'No results' }] })
    expect(byFile['layout/header.md']).toMatchObject({ route: null, hasBlock: false })
    expect(byFile['pages/2-blog/1-first-post.md']).toMatchObject({ route: '/blog/first-post' })
  })

  it('leaves out a section that holds its words, a type with none, a form, and a branch the site doesn’t translate', async () => {
    const files = (await sectionsMissingWords(SITE)).map((f) => f.file)
    expect(files).not.toContain('pages/home/3-whole.md')
    expect(files).not.toContain('pages/home/4-signup.md')
    expect(files).not.toContain('pages/home/5-plain.md')
    expect(files).not.toContain('pages/docs/1-catalog.md')
  })

  it('names the item a block sits under, which the section doesn’t read as its own', async () => {
    // A block at the end of a section with items is the last item's (⛔ listed as no block until 2026-11-22).
    w('site/pages/home/6-end.md', '---\ntype: Catalog\n---\n\n# With items\n\n### One\n\nThe first.\n\n### Two & three\n\nThe last.\n\n```yaml:labels\nsearch: Find\nempty: Nothing\n```\n')
    const entry = (await sectionsMissingWords(SITE)).find((f) => f.file === 'pages/home/6-end.md')
    expect(entry).toMatchObject({ hasBlock: false, inItem: 'Two & three', words: [{ name: 'search' }, { name: 'empty' }] })
    expect((await sectionsMissingWords(SITE)).find((f) => f.file === 'pages/home/1-catalog.md')).not.toHaveProperty('inItem')
  })

  it('reads a route as the collector does', () => {
    const pages = join(SITE, 'pages')
    expect(routeOfSection(join(pages, 'home/1-catalog.md'), pages, 'home')).toBe('/')
    expect(routeOfSection(join(pages, '2-blog/1-first-post.md'), pages, 'home')).toBe('/blog/first-post')
  })
})

describe('withWords — the defaults written in as the section’s own block', () => {
  const WORDS = [{ name: 'search', text: 'Search…' }, { name: 'empty', text: 'No "results"' }]
  const read = (text) => parseContent(markdownToProseMirror(parseFrontmatter(text).body))

  it('at the end of a section with no items', () => {
    const result = withWords('---\ntype: Catalog\n---\n\n# Our solutions\n\nFind one.\n', 'labels', WORDS)
    expect(result.text).toBe('---\ntype: Catalog\n---\n\n# Our solutions\n\nFind one.\n\n```yaml:labels\nsearch: "Search…"\nempty: "No \\"results\\""\n```\n')
    expect(read(result.text).data.labels).toEqual({ search: 'Search…', empty: 'No "results"' })
  })

  it('before the first item, never inside one', () => {
    const text = '# Plans\n\nPick one.\n\n### Basic\n\nFor one site.\n\n### Pro\n\nFor many.\n'
    const result = withWords(text, 'labels', WORDS)
    const content = read(result.text)
    expect(content.data.labels).toEqual({ search: 'Search…', empty: 'No "results"' })
    expect(content.items.map((item) => item.data)).toEqual([{}, {}])
    expect(content.items.map((item) => item.title)).toEqual(['Basic', 'Pro'])
  })

  it('never inside a block of code, and keeps the file’s line endings', () => {
    const text = '# Setup\r\n\r\n```sh\r\n# not a heading\r\nnpm i\r\n```\r\n'
    const result = withWords(text, 'labels', WORDS)
    expect(result.text.split('\r\n').length).toBeGreaterThan(5)
    expect(result.text).not.toMatch(/[^\r]\n/)
    expect(read(result.text).snippets[0].code).toBe('# not a heading\nnpm i')
    expect(read(result.text).data.labels.search).toBe('Search…')
  })

  it('leaves a section that holds a block of its own to its author', () => {
    expect(withWords('# T\n\n```yaml:labels\nsearch: Find\n```\n', 'labels', WORDS)).toEqual({ reason: 'it holds a `labels` block of its own' })
  })
})
