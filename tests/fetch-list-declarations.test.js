import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { validateDataInputs } from '../src/validate-data.js'
import { resolveFetchConfigs } from '@uniweb/core'

/**
 * `data: [team, articles]` means **fetch each**.
 *
 * ## What it did before
 *
 * It kept `[0]` and discarded the rest — silently. No warning, no error, and the
 * array was not carried forward on the section, so nothing downstream could
 * recover it. An author writing a list got one dataset and a section rendering
 * empty. The source comment claimed the rest arrived "via `inheritData`";
 * `inheritData` is a boolean opt-out on a section's `meta.js` and never consumed
 * list elements, so that was never true.
 *
 * ## ⭐ Why plural is the principled shape, not an accommodation
 *
 * Everything downstream was already plural and only the declaration was not:
 *
 * | | cardinality |
 * |---|---|
 * | `content.data` — what a component reads | **many** (`prepare-props` merges every key) |
 * | `EntityStore` delivery — walks the cascade | **many** (collect-all, `Promise.all`) |
 * | `data:` / `fetch:` — what an author writes | **was one per level** |
 *
 * ⚖️ **Plural DECLARATIONS are not plural REQUESTS.** How many round trips this
 * becomes belongs to the fetcher — the store assembles every config before
 * dispatching any, which is where a batching source would coalesce. Nothing in
 * the authoring language encodes a transport assumption, because the file lane
 * genuinely has two artifacts and most sources cannot batch at all.
 */

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-fetchlist-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A site whose one section reads two datasets, with `pageData` declaring them. */
function site(pageData) {
  const siteRoot = join(root, 'site')
  const fdn = join(root, 'src')

  mkdirSync(join(fdn, 'sections', 'Both'), { recursive: true })
  writeFileSync(join(fdn, 'main.js'), 'export const vars = {}\n')
  writeFileSync(
    join(fdn, 'sections', 'Both', 'meta.js'),
    "export default { data: { team: '@/member', articles: '@/article' } }\n"
  )
  writeFileSync(join(fdn, 'sections', 'Both', 'index.jsx'), 'export default function Both() { return null }\n')
  writeFileSync(
    join(fdn, 'package.json'),
    JSON.stringify({ name: 'src', type: 'module', main: './_entry.generated.js' })
  )
  mkdirSync(join(fdn, 'schemas'), { recursive: true })
  writeFileSync(join(fdn, 'schemas', 'member.yml'), 'fields:\n  name:\n    type: string\n')
  writeFileSync(join(fdn, 'schemas', 'article.yml'), 'fields:\n  title:\n    type: string\n')

  mkdirSync(join(siteRoot, 'entities', 'member'), { recursive: true })
  writeFileSync(join(siteRoot, 'entities', 'member', 'ada.yml'), 'name: Ada\n')
  mkdirSync(join(siteRoot, 'entities', 'article'), { recursive: true })
  writeFileSync(join(siteRoot, 'entities', 'article', 'a1.yml'), 'title: One\n')
  writeFileSync(
    join(siteRoot, 'site.yml'),
    'name: t\nqueries:\n  team: { model: "@/member" }\n  articles: { model: "@/article" }\n'
  )

  const page = join(siteRoot, 'pages', 'home')
  mkdirSync(page, { recursive: true })
  writeFileSync(join(page, 'page.yml'), `title: Home\ndata: ${pageData}\n`)
  writeFileSync(join(page, 'index.md'), '---\ntype: Both\n---\n\n# Both\n')

  return { siteRoot, foundationPath: fdn }
}

/** The keys a component would find on `content.data`. */
async function deliveredKeys(paths) {
  const content = await collectSiteContent(paths.siteRoot, {})
  const page = content.pages[0]
  const configs = resolveFetchConfigs(
    [page.sections[0].fetch, page.fetch, content.config.fetch],
    content.config,
    []
  )
  return [...configs.keys()]
}

describe('a list declaration', () => {
  it('⭐ delivers EVERY entry, not just the first', async () => {
    expect(await deliveredKeys(site('[team, articles]'))).toEqual(['team', 'articles'])
  })

  it('gives each entry its own compiled address', async () => {
    // Two keys resolving to one file would look like success and serve the
    // wrong records under one of them.
    const content = await collectSiteContent(site('[team, articles]').siteRoot, {})
    const paths = content.pages[0].fetch.map((f) => f.path)
    expect(new Set(paths).size).toBe(2)
  })

  it('satisfies a section that declares both keys', async () => {
    // The join added 2026-09-02 reports a section reading keys nothing
    // delivers. A page declaring both must not trip it.
    const report = await validateDataInputs(site('[team, articles]'))
    expect(report.setupErrors).toEqual([])
  })

  it('delivers only what is listed — a shorter list delivers less', async () => {
    // ⭐ The control for the first test: same fixture, one entry removed, and
    // the delivered set shrinks with it. Without this, "delivers every entry"
    // would pass equally well against code that delivered everything declared
    // anywhere, which is a different behaviour that happens to look the same on
    // a two-item fixture.
    expect(await deliveredKeys(site('[team]'))).toEqual(['team'])
  })

  it('⚖️ and the section is NOT flagged for the key it did not get', async () => {
    // `data:` in `meta.js` is a hint, not a delivery gate: the section reads
    // `team` and `articles`, the page supplies `team`, and that is a legitimate
    // site. The join fires only when a section reads NONE of what arrived —
    // widening it here would make the check fire on correct sites.
    const report = await validateDataInputs(site('[team]'))
    expect(report.setupErrors).toEqual([])
  })
})

describe('⛔ a single declaration is untouched', () => {
  it('still delivers exactly one key', async () => {
    expect(await deliveredKeys(site('team'))).toEqual(['team'])
  })

  it('is still an OBJECT on the page, not a one-element array', async () => {
    // ⭐ The property that makes this change safe for every consumer reading
    // `fetch.path`: the emitted shape reflects the cardinality of the RESULT,
    // so nothing that resolves to one fetch changes shape. Only content that
    // could not previously have worked gains an array.
    const content = await collectSiteContent(site('team').siteRoot, {})
    expect(Array.isArray(content.pages[0].fetch)).toBe(false)
    expect(content.pages[0].fetch.as).toBe('team')
  })

  it('a ONE-entry list collapses to that same object shape', async () => {
    const content = await collectSiteContent(site('[team]').siteRoot, {})
    expect(Array.isArray(content.pages[0].fetch)).toBe(false)
    expect(content.pages[0].fetch.as).toBe('team')
  })
})
