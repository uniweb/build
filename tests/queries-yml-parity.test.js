// `queries.yml` resolves a declaration exactly as `collections.yml` did.
//
// ⭐ THE EXPECTATIONS BELOW WERE CAPTURED FROM THE OLD RESOLVER, not written by
// hand. Before `resolveQueriesConfig` was changed, the equivalent
// `collections/collections.yml` fixture was run through it and its
// `declarations` dumped; that dump is what `EXPECTED` holds. So this pins a
// MEASURED parity rather than a belief about what the old code did.
//
// Why parity is the criterion for this step at all: the restructure moves three
// things (the pool, the folder, the query) and only the last of them lands here.
// If the declaration reader changes meaning at the same time as its inputs move,
// no later failure can be attributed. This step swaps the reader and nothing else.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveQueriesConfig, QUERIES_YML_RELPATH } from '../src/site/queries-config.js'

// Captured 2026-08-29 from the pre-change resolver, given the same declarations
// written as `collections/collections.yml::collections`.
//
// ⚠️ ONE FIELD WAS SINCE DROPPED, DELIBERATELY: `path`. The captured baseline had
// it, because while the pool was `collections/<name>/` a declaration had to name a
// directory. `entities/{schema}/` addresses the pool by schema, so a file-based
// query has no path to carry — emitting one would ship a derivation as authored
// config, which is the defect `deferred:` already taught. Everything else is
// byte-for-byte the value the old resolver produced.
const EXPECTED = {
  members: {
    name: 'members',
    schema: '@/member',
    sort: 'order asc',
    schemaExplicit: true,
  },
  people: {
    name: 'people',
    schema: '@std/person',
    where: { active: true },
    limit: 10,
    schemaExplicit: true,
  },
  articles: {
    name: 'articles',
    sort: 'date desc',
    excerpt: { maxLength: 200 },
    detailUrl: '/api/articles/{slug}',
    deferred: ['content'],
    queryable: { tags: { type: 'enum' } },
    schema: '@/articles',
    schemaExplicit: false,
  },
}

const QUERIES_YML = [
  '# A bare map. No root key.',
  'members:',
  "  schema: '@/member'",
  '  sort: order asc',
  'people:',
  "  schema: '@std/person'",
  '  where: { active: true }',
  '  limit: 10',
  'articles:',
  '  sort: date desc',
  '  excerpt: { maxLength: 200 }',
  "  detailUrl: '/api/articles/{slug}'",
  '  deferred: [content]',
  '  queryable: { tags: { type: enum } }',
  '',
].join('\n')

describe('queries.yml — parity with the collections.yml it replaces', () => {
  let root
  const site = (files) => {
    root = mkdtempSync(join(tmpdir(), 'queries-parity-'))
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, body)
    }
    return root
  }
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('resolves declarations identically to the captured baseline', async () => {
    const dir = site({ 'site.yml': 'name: Parity\n', [QUERIES_YML_RELPATH]: QUERIES_YML })
    const { declarations } = await resolveQueriesConfig(dir)
    expect(declarations).toEqual(EXPECTED)
  })

  it('reads the file as a BARE map — a `queries:` root key is not unwrapped', async () => {
    // The failure this guards is silent: a wrapper would resolve as a query
    // literally named `queries`, which builds and delivers an empty file.
    const dir = site({
      'site.yml': 'name: Parity\n',
      [QUERIES_YML_RELPATH]: 'queries:\n  members:\n    schema: "@/member"\n',
    })
    const { declarations } = await resolveQueriesConfig(dir)
    expect(Object.keys(declarations)).toEqual(['queries'])
    expect(declarations.members).toBeUndefined()
  })

  it('layers queries.yml over site.yml::queries, per key', async () => {
    const dir = site({
      'site.yml': 'name: Parity\nqueries:\n  members:\n    sort: name asc\n    limit: 5\n',
      [QUERIES_YML_RELPATH]: 'members:\n  sort: order asc\n',
    })
    const { declarations } = await resolveQueriesConfig(dir)
    expect(declarations.members.sort).toBe('order asc') // queries.yml wins
    expect(declarations.members.limit).toBe(5) // site.yml sibling survives
  })

  it('site.yml::queries alone resolves the same way', async () => {
    const dir = site({
      'site.yml': "name: Parity\nqueries:\n  members:\n    schema: '@/member'\n    sort: order asc\n",
    })
    const { declarations } = await resolveQueriesConfig(dir)
    expect(declarations.members).toEqual(EXPECTED.members)
  })

  it('a file-based query carries NO path — the schema addresses the pool', async () => {
    const dir = site({ 'site.yml': 'name: Parity\n', [QUERIES_YML_RELPATH]: 'posts: {}\n' })
    const { declarations } = await resolveQueriesConfig(dir)
    expect(declarations.posts.path).toBeUndefined()
    expect(declarations.posts.schema).toBe('@/posts') // the query-name convention
  })

  it('the string shorthand names the SCHEMA', async () => {
    const dir = site({ 'site.yml': 'name: Parity\n', [QUERIES_YML_RELPATH]: "posts: '@/article'\n" })
    const { declarations } = await resolveQueriesConfig(dir)
    expect(declarations.posts.schema).toBe('@/article')
    expect(declarations.posts.schemaExplicit).toBe(true)
    expect(declarations.posts.path).toBeUndefined()
  })

  it('no queries.yml and no site.yml::queries → no declarations', async () => {
    const dir = site({ 'site.yml': 'name: Parity\n' })
    const cfg = await resolveQueriesConfig(dir)
    expect(cfg.hasQueriesYml).toBe(false)
    expect(cfg.declarations).toEqual({})
  })

  // ⛔ CONTROL. Every assertion above is about a file being READ; without this one,
  // a resolver that read nothing at all would pass the negative cases and the
  // duplicate-shaped ones. This proves the instrument works.
  it('CONTROL — collections.yml is no longer read at all', async () => {
    const dir = site({
      'site.yml': 'name: Parity\n',
      'collections/collections.yml': "collections:\n  members:\n    schema: '@/member'\n",
    })
    const { declarations } = await resolveQueriesConfig(dir)
    expect(declarations).toEqual({})
  })
})
