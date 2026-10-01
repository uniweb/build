// ⭐ WHAT A FOUNDATION REGISTERS IS LOWERED [Diego, 2026-09-29]: `content:` becomes the
// canonical list `describeContent` returns, `children:` the object form `lowerChildren`
// returns, and a `'md:<tag>'` key in `data:` the key a component reads. The retired
// `visuals` and `content:` element `data` are refused, naming what replaces them.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverComponents, buildSchema, reportPlacementDeclarations, SCHEMA_FORMAT } from '../src/schema.js'
import { extractRuntimeSchema } from '../src/runtime-schema.js'
import { buildRegistryPackage } from '../src/uwx/registry-package.js'
import { generateDocsFromSchema } from '../src/docs.js'
import { FOUNDATION_SCHEMA_FORMAT } from '@uniweb/schemas/foundation'

let dir

function write(rel, text) {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), text)
}

function meta(name, fields) {
  write(`sections/${name}/meta.js`, `export default ${JSON.stringify(fields)}\n`)
  write(`sections/${name}/${name}.jsx`, `export default function ${name}() { return null }\n`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uw-lowered-entry-'))
  write('package.json', JSON.stringify({ name: 'src', version: '1.0.0', type: 'module' }))
  write('main.js', "export default { name: '@acme/site-kit' }\n")
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('an entry, lowered', () => {
  it('content: is the canonical list, media spellings as `media`', async () => {
    meta('Hero', { content: { title: 'Headline [1]', paragraphs: 'Pitch [0-2]', image: 'Product shot [1]', icons: true } })
    const { Hero } = await discoverComponents(dir)
    expect(Hero.content).toEqual([
      { element: 'title', kind: 'heading', label: 'Headline', min: 1, max: 1 },
      { element: 'paragraphs', kind: 'prose', label: 'Pitch', min: 0, max: 2 },
      { element: 'media', kind: 'media', types: ['image'], label: 'Product shot', min: 1, max: 1 },
      { element: 'icons', kind: 'icon' },
    ])
  })

  it('children: is the object form', async () => {
    meta('Tabs', { children: 3 })
    meta('Grid', { children: { label: 'Cards', grid: [2] } })
    const { Tabs, Grid } = await discoverComponents(dir)
    expect(Tabs.children).toEqual({ max: 3 })
    expect(Grid.children).toEqual({
      label: 'Cards',
      grid: [{ value: 2, columns: 2, widths: [1, 1], template: 'repeat(2, minmax(0, 1fr))' }],
    })
  })

  it('a concept block joins the content list, and its key is the one a component reads', async () => {
    meta('Faq', {
      content: { title: 'Headline' },
      data: { 'md:faq': { label: 'Questions and answers [3+]', content: { title: 'Question', paragraphs: 'Answer' } }, team: '@std/person' },
    })
    const { Faq } = await discoverComponents(dir)
    expect(Faq.data).toEqual({ faq: {}, team: '@std/person' })
    expect(Faq.content.at(-1)).toEqual({
      key: 'faq', kind: 'concept', label: 'Questions and answers', min: 3,
      content: [
        { element: 'title', kind: 'heading', label: 'Question' },
        { element: 'paragraphs', kind: 'prose', label: 'Answer' },
      ],
    })
  })

  it('nothing declared is nothing written — absent stays unknown', async () => {
    meta('Plain', { title: 'Plain' })
    const { Plain } = await discoverComponents(dir)
    expect(Plain).not.toHaveProperty('content')
    expect(Plain).not.toHaveProperty('children')
  })

  // ⭐ Ruled 2026-10-01 [Diego]: `content: {}` or `content: []` says the component takes no
  // content — one that only reads `content.data`. ⛔ Until then it came out absent, like nothing.
  it('an empty content declaration is [] — the component takes no content', async () => {
    meta('Feed', { content: {}, data: { posts: '@std/article' } })
    meta('Banner', { content: [] })
    const { Feed, Banner } = await discoverComponents(dir)
    expect(Feed.content).toEqual([])
    expect(Banner.content).toEqual([])
  })
})

describe('the lean runtime schema', () => {
  it('delivers a concept block under its tag — the label is never a schema ref', () => {
    const runtime = extractRuntimeSchema({ data: { 'md:faq': 'Questions and answers', team: '@std/person' } })
    expect(runtime.data).toEqual({ faq: null, team: '@std/person' })
    expect(runtime.schemas).toBeUndefined()
  })

  it('reads a built entry the same way', async () => {
    meta('Faq', { data: { 'md:faq': 'Questions and answers' } })
    const { Faq } = await discoverComponents(dir)
    expect(extractRuntimeSchema(Faq).data).toEqual({ faq: null })
  })
})

describe('retired declarations are refused, naming what replaces them', () => {
  it('`visuals` → the `media` element of content:', async () => {
    meta('Split', { visuals: 'image' })
    await expect(discoverComponents(dir)).rejects.toThrow(
      /Split \(meta\.js\): `visuals` is retired.*`media: \{ label: 'Visual \[0-1\]', types: \['image'\] \}`/,
    )
  })

  it('the content: element `data` → a key in data:', async () => {
    meta('ApiReference', { content: { title: 'T', data: 'API definition (yaml:api block)' }, data: { api: {} } })
    await expect(discoverComponents(dir)).rejects.toThrow(
      /ApiReference \(meta\.js\): the `content:` element `data` is retired.*'md:<tag>'.*already declares `data: \{ api \}`/,
    )
  })
})

describe('the schema says which form it holds', () => {
  it('`_self.schemaFormat` — the build\'s 2, and the registered blob\'s 3, normalized', async () => {
    meta('Hero', { content: { title: 'Headline' }, data: { team: '@/member' } })
    write('schemas/member.yml', 'name: member\nfields:\n  name: string\n')
    const schema = await buildSchema(dir)
    expect(SCHEMA_FORMAT).toBe(2)
    expect(schema._self.schemaFormat).toBe(SCHEMA_FORMAT)
    const pkg = buildRegistryPackage({ schema, scope: '@acme' })
    const blob = pkg.entities.find((e) => e.model === '@uniweb/foundation-schema').schema
    expect(blob._self.schemaFormat).toBe(FOUNDATION_SCHEMA_FORMAT)
    expect(blob.Hero.content).toEqual([{ element: 'title', kind: 'heading', label: 'Headline' }])
    expect(blob.Hero.data).toEqual({ team: { kind: 'schema', schema: '@acme/member', whole: false } })
  })

  it('a main.js key of the same name does not replace it', async () => {
    write('main.js', "export default { name: '@acme/site-kit', schemaFormat: 7 }\n")
    expect((await buildSchema(dir))._self.schemaFormat).toBe(SCHEMA_FORMAT)
  })
})

describe('a data: value register will refuse is said when the schema is built', () => {
  it('an inline field map that is not a data schema — the build goes on, and says register stops', async () => {
    meta('Article', { content: {}, data: { articles: { content: { type: 'object', default: null } } } })
    const warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(message))
    const schema = await buildSchema(dir)
    expect(schema.Article.content).toEqual([])
    expect(warnings.join('\n')).toMatch(
      /Article \(meta\.js\): data\.articles is an inline field map that is not a valid data schema: object field 'content'.*`uniweb register` refuses it/
    )
  })

  it('CONTROL — a valid map, a ref and a key with no schema say nothing', async () => {
    meta('Feed', { data: { links: { href: 'url' }, team: '@std/person', raw: {} } })
    const warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(message))
    await buildSchema(dir)
    expect(warnings.filter((w) => /register` refuses/.test(w))).toEqual([])
  })
})

describe('what lowering could not read is said once, when the schema is built', () => {
  it('not at discovery, and once by buildSchema', async () => {
    meta('Hero', { content: { title: 'T', media: 'M [1]', image: 'I [1]', zork: 'Z' }, children: { colums: 2 } })
    const warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(message))

    await discoverComponents(dir)
    expect(warnings).toEqual([])

    await buildSchema(dir)
    const said = warnings.filter((w) => w.startsWith('Warning: Hero (meta.js):'))
    expect(said).toHaveLength(3)
    expect(said.join('\n')).toMatch(/`content.media` and `content.image` both take an image/)
    expect(said.join('\n')).toMatch(/`content.zork` is not a content element/)
    expect(said.join('\n')).toMatch(/children\.colums/)
  })

  it('an entry handed in as written is read the same way', () => {
    const warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(message))
    reportPlacementDeclarations({ Hero: { name: 'Hero', content: { sequence: 'Prose [1]' } } })
    expect(warnings).toEqual([expect.stringMatching(/Hero \(meta\.js\):.*count.*means nothing/)])
  })
})

describe('COMPONENTS.md reads the lowered list', () => {
  it('in the bracket syntax a developer writes', async () => {
    meta('Features', {
      content: {
        title: 'Headline [1]',
        image: 'Photo',
        sequence: { label: 'Body', except: ['math'] },
        items: { label: 'Cards [3-6]', content: { title: 'Feature' } },
      },
      data: { 'md:faq': 'Questions [2+]' },
    })
    const md = generateDocsFromSchema(await buildSchema(dir))
    expect(md).toContain('**title** — Headline [1]')
    expect(md).toContain('**media** (image) — Photo')
    expect(md).toContain('**sequence** — Body\n  Leaves out: math')
    expect(md).toContain('**items** — Cards [3-6]\n  Each entry: title — Feature')
    expect(md).toContain('**md:faq** — Questions [2+]')
  })
})
