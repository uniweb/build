// ⭐ A record reaches a component in ONE shape, on a static site and a hosted one alike:
// the shape a host's records service answers — measured 2026-09-24 on a local backend —
// the brief's fields at the top, every other section under its own name, a markdown body
// in the schema's content body field (ruled 2026-09-24 [Diego]: static is "the same as
// hosted"). ⛔ Until then the static build compiled a record as its file held it, its body
// in `content` at the top, which no host delivers.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'
import { extractRecordContent, buildLocalizedRecords, translateRecordData } from '../src/i18n/records.js'

let ROOT
let SITE
let saved

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const read = (rel) => JSON.parse(readFileSync(join(SITE, rel), 'utf8'))
const textOf = (doc) => [...JSON.stringify(doc).matchAll(/"text":"([^"]*)"/g)].map((m) => m[1])

// A site whose foundation is local and UNBUILT — no `dist/` — as under `pnpm dev`: the
// schemas are read from its source.
function site(queriesYml) {
  w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n')
  w('site/queries.yml', queriesYml)
  w('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  w('fdn/package.json', { name: '@acme/base', type: 'module', main: './_entry.generated.js' })
  // A brief, and a body in a section of its own — `@std/article`'s layout.
  w(
    'fdn/schemas/post.yml',
    [
      'name: post',
      'sections:',
      '  card:',
      '    brief: true',
      '    fields: { title: { type: string, required: true }, slug: string, date: date }',
      '  details:',
      '    fields: { content: richtext, author: string }',
      '',
    ].join('\n')
  )
  // The `fields:` shorthand, its body a markup text field.
  w('fdn/schemas/bio.yml', 'name: bio\nfields:\n  name: string\n  text: markdown\n')
  // A brief and a list, and no field a markdown body could fill.
  w(
    'fdn/schemas/course.yml',
    'name: course\nsections:\n  identity:\n    brief: true\n    fields: { title: string }\n  modules:\n    many: true\n    fields: { title: string }\n'
  )
}

const compile = async (queries) => {
  const byQuery = await processQueries(SITE, queries, undefined, '/')
  await writeQueryFiles(SITE, byQuery, queries)
  return byQuery
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'records-delivered-'))
  SITE = join(ROOT, 'site')
  saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
})
afterEach(() => {
  ;[console.log, console.warn] = saved
  rmSync(ROOT, { recursive: true, force: true })
})

describe('a record of a data schema is delivered as a host delivers it', () => {
  it('the brief at the top, another section under its name, the body in its content field', async () => {
    site('posts:\n  schema: "@/post"\n')
    w('site/records/post/hello.md', '---\ncard:\n  title: Hello\n  date: 2026-01-02\ndetails:\n  author: Ada\n---\n\nThe body.\n')
    const { posts } = await compile({ posts: { schema: '@/post' } })
    const [post] = posts
    expect(post).toMatchObject({ title: 'Hello', date: '2026-01-02', slug: 'hello', $name: 'hello' })
    expect(post.details.author).toBe('Ada')
    expect(textOf(post.details.content)).toEqual(['The body.'])
    // Nothing of the file's shape, and no body at the top.
    expect(post).not.toHaveProperty('card')
    expect(post).not.toHaveProperty('content')
  })

  it('$name is the file\'s handle, even where the brief declares a `slug` of its own', async () => {
    site('posts:\n  schema: "@/post"\n')
    w('site/records/post/2026-hello.md', '---\ncard:\n  title: Hello\n  slug: hello-world\n---\n\nBody.\n')
    const [post] = (await compile({ posts: { schema: '@/post' } })).posts
    expect(post.$name).toBe('2026-hello')
    expect(post.slug).toBe('hello-world')
  })

  it('a query sorts by a brief field, which the delivered record holds at the top', async () => {
    site('posts:\n  schema: "@/post"\n  sort: date desc\n')
    w('site/records/post/old.md', '---\ncard:\n  title: Old\n  date: 2025-01-01\n---\n')
    w('site/records/post/new.md', '---\ncard:\n  title: New\n  date: 2026-01-01\n---\n')
    const { posts } = await compile({ posts: { schema: '@/post', sort: 'date desc' } })
    expect(posts.map((p) => p.title)).toEqual(['New', 'Old'])
  })

  it('a `where` outside the brief answers as the records service does: a path through its section', async () => {
    // A bare field outside the brief is missing on every delivered record; a dotted path that
    // starts at the section reaches it — the query language's rule on both lanes.
    site('posts:\n  schema: "@/post"\n')
    w('site/records/post/a.md', '---\ncard:\n  title: A\ndetails:\n  author: Ada\n---\n')
    w('site/records/post/b.md', '---\ncard:\n  title: B\ndetails:\n  author: Bob\n---\n')
    const byPath = await processQueries(SITE, { posts: { schema: '@/post', where: { 'details.author': 'Ada' } } }, undefined, '/')
    expect(byPath.posts.map((p) => p.title)).toEqual(['A'])
    const bare = await processQueries(SITE, { posts: { schema: '@/post', where: { author: 'Ada' } } }, undefined, '/')
    expect(bare.posts).toEqual([])
  })

  it('a YAML record, and a `many` section — delivered as a list under its name', async () => {
    site('courses:\n  schema: "@/course"\n')
    w('site/records/course/rust.yml', 'identity:\n  title: Rust 101\nmodules:\n  - title: Basics\n  - title: Ownership\n')
    const [course] = (await compile({ courses: { schema: '@/course' } })).courses
    expect(course).toMatchObject({ title: 'Rust 101', $name: 'rust' })
    expect(course.modules.map((m) => m.title)).toEqual(['Basics', 'Ownership'])
    expect(course).not.toHaveProperty('identity')
  })

  it('a markup `text` body field holds the markdown source, as a host delivers it', async () => {
    site('bios:\n  schema: "@/bio"\n')
    w('site/records/bio/ada.md', '---\nname: Ada\n---\n\nWrote the *first* program.\n')
    const [bio] = (await compile({ bios: { schema: '@/bio' } })).bios
    expect(bio.text).toBe('\nWrote the *first* program.\n')
    expect(bio).not.toHaveProperty('content')
  })

  it('a body its schema has no field for stays `content` — a push refuses that one', async () => {
    site('courses:\n  schema: "@/course"\n')
    w('site/records/course/go.md', '---\nidentity:\n  title: Go\n---\n\nNo field holds this.\n')
    const [course] = (await compile({ courses: { schema: '@/course' } })).courses
    expect(textOf(course.content)).toEqual(['No field holds this.'])
  })

  it('CONTROL — a record with no data schema is compiled as its file holds it', async () => {
    site('notes:\n  schema: "@/note"\n')
    w('site/records/note/hi.md', '---\ntitle: Hi\n---\n\nText.\n')
    const [note] = (await compile({ notes: { schema: '@/note' } })).notes
    expect(note).toMatchObject({ title: 'Hi', $name: 'hi' })
    expect(textOf(note.content)).toEqual(['Text.'])
  })

  it('⛔ a record written in the retired flat form stops the build, naming where each key goes', async () => {
    site('posts:\n  schema: "@/post"\n')
    w('site/records/post/flat.md', '---\ntitle: Flat\nauthor: Ada\n---\n\nBody.\n')
    await expect(compile({ posts: { schema: '@/post' } })).rejects.toThrow(
      /records\/post\/flat\.md: @\/post records are written by section.*"title" under "card:"; "author" under "details:"/
    )
  })

  it('a `deferred:` split strips the non-brief sections from the list, not the brief', async () => {
    site('posts:\n  schema: "@/post"\n  deferred: [details]\n')
    w('site/records/post/hello.md', '---\ncard:\n  title: Hello\n---\n\nThe body.\n')
    await compile({ posts: { schema: '@/post', deferred: ['details'] } })
    expect(read('public/data/posts.json')[0]).toMatchObject({ title: 'Hello' })
    expect(read('public/data/posts.json')[0]).not.toHaveProperty('details')
    expect(textOf(read('public/data/posts/hello.json').details.content)).toEqual(['The body.'])
  })

  it('@std schemas resolve without a foundation of their own — from the build\'s copy', async () => {
    site('articles:\n  schema: "@std/article"\n')
    w('site/records/std/article/hi.md', '---\narticle:\n  title: Hi\n---\n\nBody text.\n')
    const [article] = (await compile({ articles: { schema: '@std/article' } })).articles
    expect(article.title).toBe('Hi')
    expect(textOf(article.article_body.content)).toEqual(['Body text.'])
  })
})

describe('a delivered record is translated where it holds its body', () => {
  const queries = { posts: { schema: '@/post', deferred: ['details'] } }
  const setup = async () => {
    site('posts:\n  schema: "@/post"\n  deferred: [details]\n')
    w('site/records/post/hello.md', '---\ncard:\n  title: Hello\n---\n\n## A heading\n\nThe body.\n')
    await compile(queries)
  }
  const spanish = async () => {
    const manifest = await extractRecordContent(SITE)
    const hashOf = (source) => Object.entries(manifest.units).find(([, u]) => u.source === source)?.[0]
    return {
      manifest,
      translations: { [hashOf('Hello')]: 'Hola', [hashOf('A heading')]: 'Un encabezado', [hashOf('The body.')]: 'El cuerpo.' },
    }
  }

  it('extraction finds the body in its section, and names it by its path', async () => {
    await setup()
    const { manifest } = await spanish()
    const heading = Object.values(manifest.units).find((u) => u.source === 'A heading')
    expect(heading.field).toBe('details.content.heading.0')
    expect(heading.contexts).toEqual([{ record: 'post/hello' }])
  })

  it('a localized build translates the body where it is held', async () => {
    await setup()
    const { translations } = await spanish()
    w('site/locales/records/es.json', translations)
    await buildLocalizedRecords(SITE, { locales: ['es'], outputDir: join(SITE, 'dist') })
    const record = read('dist/es/data/posts/hello.json')
    expect(record.title).toBe('Hola')
    expect(textOf(record.details.content)).toEqual(['Un encabezado', 'El cuerpo.'])
  })

  it('a free-form translation lands in the delivered shape — body in its field, frontmatter by section', async () => {
    await setup()
    w('site/locales/freeform/es/records/post/hello.md', '---\ncard:\n  title: Hola (libre)\ndetails:\n  author: Ada\n---\n\nCuerpo libre.\n')
    const record = read('public/data/posts/hello.json')
    const out = await translateRecordData(record, 'posts', SITE, {
      locale: 'es',
      localesDir: join(SITE, 'locales'),
      freeformEnabled: true,
    })
    expect(out.title).toBe('Hola (libre)')
    expect(out.details.author).toBe('Ada')
    expect(textOf(out.details.content)).toEqual(['Cuerpo libre.'])
    expect(out).not.toHaveProperty('card')
    expect(out).not.toHaveProperty('content')
  })
})
