/**
 * Two things a site translating only its own pages needs from `uniweb i18n`:
 *
 * - `i18n.exclude` names branches the site doesn't translate (a mounted repo's docs shown in their
 *   own language): extraction takes no strings from them, so `init` and `status`, which read the
 *   manifest, leave them alone. Routes as `agents.exclude` takes them.
 * - `status` counts a translation only where there is one: an empty entry is missing (the build
 *   shows the source for it), and an entry that is the source's own text, what `init` writes, is
 *   counted apart. ⛔ Until 2026-11-11 any entry counted, so a file `init` had just made read as
 *   complete.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { isInExcludedBranch } from '@uniweb/projections'
import { extractTranslatableContent } from '../src/i18n/extract.js'
import { getTranslationStatus } from '../src/i18n/index.js'

const page = (route, text) => ({ route, title: text, sections: [{ id: 's1', stableId: 's1', content: markdownToProseMirror(`# ${text}\n\nBody of ${text}.`) }] })

const sources = (manifest) => Object.values(manifest.units).map((unit) => unit.source).sort()

describe('i18n.exclude', () => {
  const site = (exclude) => ({
    config: { defaultLanguage: 'en', ...(exclude ? { i18n: { exclude } } : {}) },
    pages: [page('/', 'Home'), page('/docs', 'Docs'), page('/docs/setup', 'Setup'), page('/docsite', 'Elsewhere')],
  })

  it('takes no strings from an excluded branch, its root and every page under it', () => {
    expect(sources(extractTranslatableContent(site(['/docs'])))).toEqual(['Body of Elsewhere.', 'Body of Home.', 'Elsewhere', 'Home'])
  })

  it('CONTROL — with nothing excluded, every page gives its strings', () => {
    expect(sources(extractTranslatableContent(site(null)))).toHaveLength(8)
  })

  it('reads its routes as agents.exclude does: whole segments, slashes optional', () => {
    for (const written of ['/docs', 'docs', '/docs/']) {
      expect(isInExcludedBranch('/docs/setup', [written])).toBe(true)
    }
    expect(isInExcludedBranch('/docsite', ['/docs'])).toBe(false)
    expect(isInExcludedBranch('/', ['/docs'])).toBe(false)
    expect(isInExcludedBranch('/docs', null)).toBe(false)
  })
})

describe('uniweb i18n status', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'i18n-status-'))
    mkdirSync(join(dir, 'locales'))
    const units = { a: { source: 'Hello' }, b: { source: 'World' }, c: { source: 'Docs' }, d: { source: 'Four' }, e: { source: 'Bold', markup: '**Bold**' } }
    writeFileSync(join(dir, 'locales', 'manifest.json'), JSON.stringify({ version: '1.0', defaultLocale: 'en', units }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('counts only real translations; a copy of the source apart, an empty entry as missing', async () => {
    // `a` translated, `b` and `e` the source's own text (`init` writes `markup` where there is one),
    // `c` empty (`init --empty`), `d` absent.
    writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify({ a: 'Hola', b: 'World', c: '', e: '**Bold**' }))
    const { locales } = await getTranslationStatus(dir, { locales: ['es'] })
    expect(locales.es).toMatchObject({ translated: 1, unchanged: 2, missing: 2, coverage: 20 })
  })

  it('an entry with words only in its context overrides is a translation', async () => {
    writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify({ a: { overrides: { '/:s1': 'Hola' } } }))
    const { locales } = await getTranslationStatus(dir, { locales: ['es'] })
    expect(locales.es.translated).toBe(1)
  })
})
