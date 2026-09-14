/**
 * An unquoted date in YAML is the string the author wrote — the same value as the
 * quoted one — in every file the build reads as site content or configuration.
 *
 * ⛔ js-yaml's default schema resolves an unquoted `2025-06-01` (or
 * `2025-06-01T10:20:30Z`) to a JS `Date`. Measured before the shared schema:
 *
 *   - a query's fixed `where: { date: { gte: '2025-01-01' } }` compiled to ZERO records,
 *     with no warning — `@uniweb/core`'s evaluator compares a string with a string, and
 *     a Date is neither;
 *   - `sort: date desc` left the compiled file in filename order;
 *   - the compiled JSON said `2025-06-01T00:00:00.000Z` where the author wrote `2025-06-01`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../src/utils/yaml-schema.js'
import { collectSiteContent } from '../src/site/content-collector.js'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'
import { resolveQueriesConfig } from '../src/site/queries-config.js'
import { readEntityFile } from '../src/uwx/entity-source.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const quiet = async (fn) => {
  const saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    [console.log, console.warn] = saved
  }
}
const compile = (queries) => quiet(() => processQueries(ROOT, queries, undefined, '/'))

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'yaml-dates-'))
  w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a record\'s unquoted date reaches the compiled record as written', () => {
  it('in a markdown record\'s frontmatter', async () => {
    w('entities/article/a.md', '---\ntitle: A\ndate: 2025-06-01\n---\n\nBody.\n')
    const { articles } = await compile({ articles: { schema: '@/article' } })
    expect(articles[0].date).toBe('2025-06-01')
  })

  it('in a .yml record — a date and a timestamp', async () => {
    w('entities/event/launch.yml', 'title: Launch\ndate: 2025-06-01\nat: 2025-06-01T10:20:30Z\n')
    const { events } = await compile({ events: { schema: '@/event' } })
    expect(events[0].date).toBe('2025-06-01')
    expect(events[0].at).toBe('2025-06-01T10:20:30Z')
  })

  it('in an array-form .yml file', async () => {
    w('entities/event/all.yml', '- slug: a\n  date: 2025-06-01\n- slug: b\n  date: 2024-01-02\n')
    const { events } = await compile({ events: { schema: '@/event' } })
    expect(events.map((e) => e.date)).toEqual(['2025-06-01', '2024-01-02'])
  })
})

describe('a query over unquoted dates', () => {
  beforeEach(() => {
    w('entities/article/a-old.md', '---\ntitle: Old\ndate: 2024-03-01\n---\n')
    w('entities/article/b-mid.md', '---\ntitle: Mid\ndate: 2025-02-01\n---\n')
    w('entities/article/c-new.md', '---\ntitle: New\ndate: 2025-06-01\n---\n')
  })

  it('a fixed `where` on dates selects at build time', async () => {
    const { recent } = await compile({ recent: { schema: '@/article', where: { date: { gte: '2025-01-01' } } } })
    expect(recent.map((r) => r.title).sort()).toEqual(['Mid', 'New'])
  })

  it('`sort: date desc` orders the compiled file — the reverse of filename order', async () => {
    const queries = { byDate: { schema: '@/article', sort: 'date desc' } }
    const byQuery = await compile(queries)
    await quiet(() => writeQueryFiles(ROOT, byQuery, queries))
    const file = JSON.parse(readFileSync(join(ROOT, 'public/data/byDate.json'), 'utf8'))
    expect(file.map((r) => r.title)).toEqual(['New', 'Mid', 'Old'])
    expect(file.map((r) => r.date)).toEqual(['2025-06-01', '2025-02-01', '2024-03-01'])
  })

  it('an unquoted date inside queries.yml `where` stays a string — and selects', async () => {
    w('queries.yml', "recent:\n  schema: '@/article'\n  where:\n    date:\n      gte: 2025-01-01\n")
    const { declarations } = await resolveQueriesConfig(ROOT)
    expect(declarations.recent.where).toEqual({ date: { gte: '2025-01-01' } })

    const content = await quiet(() => collectSiteContent(ROOT, { strict: true }))
    expect(content.config.queries.recent.where.date.gte).toBe('2025-01-01')
    const { recent } = await compile(content.config.queries)
    expect(recent.map((r) => r.title).sort()).toEqual(['Mid', 'New'])
  })
})

describe('configuration and section frontmatter keep an unquoted date as written', () => {
  it('site.yml and a section\'s frontmatter', async () => {
    w('site.yml', 'name: t\nlaunched: 2025-06-01\n')
    w('pages/home/1-hero.md', '---\ntype: Hero\nupdated: 2025-06-01T10:20:30Z\n---\n# Home\n')
    const content = await quiet(() => collectSiteContent(ROOT, { strict: true }))
    expect(content.config.launched).toBe('2025-06-01')
    expect(content.pages[0].sections[0].params.updated).toBe('2025-06-01T10:20:30Z')
  })
})

describe('the sync lane reads the same values', () => {
  it('an entity file, markdown and YAML', async () => {
    w('entities/event/launch.yml', 'title: Launch\ndate: 2025-06-01\n')
    w('entities/article/a.md', '---\ntitle: A\ndate: 2025-06-01\n---\nBody\n')
    const [yml] = await readEntityFile(join(ROOT, 'entities/event/launch.yml'))
    const [md] = await readEntityFile(join(ROOT, 'entities/article/a.md'))
    expect(yml.data.date).toBe('2025-06-01')
    expect(md.data.date).toBe('2025-06-01')
  })

  it('site.yml on the push — an unquoted timestamp is carried as written, not re-rendered', async () => {
    w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\npreview: 2026-09-10T12:34:56Z\n')
    w('pages/home/1-hero.md', '---\ntype: Hero\n---\n# Home\n')
    const doc = await quiet(() => siteProjectToDocument(ROOT))
    expect(doc.info.preview).toBe('2026-09-10T12:34:56Z')
  })
})

describe('the shared schema', () => {
  const load = (text) => yaml.load(text, YAML_OPTIONS)

  it('keeps an unquoted date or timestamp as written — the quoted value', () => {
    expect(load('a: 2025-06-01\nb: 2025-06-01T10:20:30Z\nc: 2025-06-01 10:20:30\nd: "2025-06-01"')).toEqual({
      a: '2025-06-01', b: '2025-06-01T10:20:30Z', c: '2025-06-01 10:20:30', d: '2025-06-01',
    })
    // CONTROL — js-yaml's default schema, which the build no longer reads with
    expect(yaml.load('a: 2025-06-01').a).toBeInstanceOf(Date)
  })

  it('an explicit `!!timestamp` is the text too — no reader receives a Date', () => {
    expect(load('a: !!timestamp 2025-06-01')).toEqual({ a: '2025-06-01' })
    expect(() => load('a: !!timestamp soon')).toThrow(/cannot resolve/)
  })

  it('resolves everything else as the default schema does', () => {
    const text = 'n: 20260910\nf: 1.5\nb: true\nz: ~\nbase: &b { x: 1 }\nmerged:\n  <<: *b\n  y: 2\nset: !!set { p }\n'
    const defaults = yaml.load(text)
    expect(load(text)).toEqual(defaults)
    expect(load(text).merged).toEqual({ x: 1, y: 2 })
  })

  it('⛔ every `yaml.load` under src/ passes it', () => {
    // A reader added without it gets Dates again, silently — the defect this file pins.
    const offenders = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.js')) {
          readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
            if (/\byaml\.load(All)?\(/.test(line) && !line.includes('YAML_OPTIONS')) {
              offenders.push(`${relative(join(import.meta.dirname, '..'), path)}:${i + 1}`)
            }
          })
        }
      }
    }
    walk(join(import.meta.dirname, '..', 'src'))
    expect(offenders).toEqual([])
  })
})
