/**
 * A query's `sort` orders its compiled file in the site's default language, on every lane that
 * compiles one. Core collates a text in English when it is given no language (`sortRecords`).
 *
 * ⛔ Until 2026-10-25 the bundle build compiled its queries with no language, so a Swedish site's
 * titles came out in English order (`Äpple` first), while dev and the build `uniweb publish` runs
 * gave Swedish order (`Äpple` last, after `Zebra`). Each page re-sorts at runtime; the compiled
 * order is what a reader of the file gets — a record's place in the search index and in `llms.txt`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentPlugin } from '../src/site/plugin.js'
import { buildSiteData } from '../src/site/build-site-data.js'

let ROOT
let saved
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

/** A site whose `notes` query sorts three records by title, in `language`. */
function notesSite(language) {
  w('site.yml', `name: T\ndefaultLanguage: ${language}\nindex: home\n`)
  w('queries.yml', 'notes:\n  schema: "@/note"\n  sort: title\n')
  w('records/note/zebra.md', '---\ntitle: Zebra\n---\n\nText.\n')
  w('records/note/apple.md', '---\ntitle: Äpple\n---\n\nText.\n')
  w('records/note/banana.md', '---\ntitle: Banan\n---\n\nText.\n')
  w('pages/home/1-hero.md', '---\ntype: Hero\n---\n\n# Home\n')
}

const compiledTitles = () => JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'notes.json'), 'utf8')).map((note) => note.title)

/** The bundle build's start, as `vite build` runs it. */
async function bundleBuildStart() {
  const plugin = siteContentPlugin({ sitePath: './', watch: false })
  await plugin.configResolved({ root: ROOT, publicDir: join(ROOT, 'public'), build: { outDir: 'dist' }, command: 'build', base: '/' })
  await plugin.buildStart()
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'query-sort-language-'))
  saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
})
afterEach(() => {
  ;[console.log, console.warn] = saved
  rmSync(ROOT, { recursive: true, force: true })
})

describe('a query sort in the site\'s language', () => {
  test('⭐ the bundle build collates in it — Swedish puts Ä after Z', async () => {
    notesSite('sv')
    await bundleBuildStart()
    expect(compiledTitles()).toEqual(['Banan', 'Zebra', 'Äpple'])
  })

  test('CONTROL — the same records in an English site', async () => {
    notesSite('en')
    await bundleBuildStart()
    expect(compiledTitles()).toEqual(['Äpple', 'Banan', 'Zebra'])
  })

  test('and the link lane agrees', async () => {
    notesSite('sv')
    await buildSiteData({ siteRoot: ROOT, distDir: join(ROOT, 'dist') })
    expect(compiledTitles()).toEqual(['Banan', 'Zebra', 'Äpple'])
  })
})
