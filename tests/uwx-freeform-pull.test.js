/**
 * ⭐ A TRANSLATION THE AUTHOR KEEPS AS A FREE-FORM FILE IS PULLED BACK INTO THAT FILE.
 *
 * A pull turns each target-language section into `locales/{locale}.json` entries when its paragraphs
 * line up with the source's, and into a free-form file otherwise. Measured 2026-09-25 on the
 * `international` template: its Spanish and French `about/story` are free-form files whose
 * paragraphs line up, so a pull into the author's copy wrote their text over the author's own
 * `es.json` / `fr.json` entries for those paragraphs, and the free-form files went unwritten.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentDocumentToProject } from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'
import { computeSourceHash, manifestText, saveManifest } from '../src/i18n/freeform-manifest.js'

let ROOT
afterEach(() => ROOT && rmSync(ROOT, { recursive: true, force: true }))

const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const HASH = computeHash('Hello world')
const FREEFORM = ['locales', 'freeform', 'es', 'pages', 'about', 'story.md']

function pull({ keepsFreeform }) {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-freeform-pull-'))
  const w = (rel, body) => {
    const p = join(ROOT, ...rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  w(['site.yml'], 'name: Site\ndefaultLanguage: en\nfoundation: "@acme/fnd@1.0.0"\n')
  w(['locales', 'es.json'], JSON.stringify({ [HASH]: 'Hola mundo (tabla)' }, null, 2) + '\n')
  if (keepsFreeform) w(FREEFORM, 'Hola mundo (libre)\n')
  siteContentDocumentToProject({
    siteRoot: ROOT,
    document: {
      info: { name: 'Site' },
      settings: { languages: ['en', 'es'] },
      pages: [
        {
          stable_id: 'about',
          mode: 'page',
          slug: { en: 'about' },
          title: { en: 'About' },
          page_sections: [
            { stable_id: 'story', type: 'Section', content: { en: docOf('Hello world'), es: docOf('Hola mundo (libre, editado)') } },
          ],
        },
      ],
    },
  })
  const es = JSON.parse(readFileSync(join(ROOT, 'locales', 'es.json'), 'utf8'))
  const freeform = existsSync(join(ROOT, ...FREEFORM)) ? readFileSync(join(ROOT, ...FREEFORM), 'utf8') : null
  return { es, freeform }
}

describe('pull — a free-form translation the site keeps', () => {
  it('⭐ goes back into its file, and leaves the author’s hash entries alone', () => {
    const { es, freeform } = pull({ keepsFreeform: true })
    expect(freeform).toBe('Hola mundo (libre, editado)\n')
    expect(es[HASH]).toBe('Hola mundo (tabla)')
    expect(existsSync(join(ROOT, 'locales', 'freeform', 'es', 'page-ids'))).toBe(false)
  })

  it('CONTROL — with no free-form file, a translation that lines up is a hash entry, as before', () => {
    const { es, freeform } = pull({ keepsFreeform: false })
    expect(es[HASH]).toBe('Hola mundo (libre, editado)')
    expect(freeform).toBe(null)
  })
})

describe('pull — a free-form translation it did not change', () => {
  it('⭐ is left as the author wrote it, though the writer’s markdown would differ', async () => {
    const { markdownToProseMirror } = await import('@uniweb/content-reader')
    // Two headings with no blank line between them: the writer's markdown adds one.
    const authored = '# Nuestra historia\n## Desde 2008\n\nHola mundo.\n'
    ROOT = mkdtempSync(join(tmpdir(), 'uwx-freeform-pull-'))
    const w = (rel, body) => {
      const p = join(ROOT, ...rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, body)
    }
    w(['site.yml'], 'name: Site\ndefaultLanguage: en\nfoundation: "@acme/fnd@1.0.0"\n')
    w(FREEFORM, authored)
    const source = markdownToProseMirror('# Our story\n## Since 2008\n\nHello world.')
    siteContentDocumentToProject({
      siteRoot: ROOT,
      document: {
        info: { name: 'Site' },
        settings: { languages: ['en', 'es'] },
        pages: [{
          stable_id: 'about', mode: 'page', slug: { en: 'about' }, title: { en: 'About' },
          page_sections: [{ stable_id: 'story', type: 'Section', content: { en: source, es: markdownToProseMirror(authored) } }],
        }],
      },
    })
    expect(readFileSync(join(ROOT, ...FREEFORM), 'utf8')).toBe(authored)
  })
})

/**
 * ⭐ A MANIFEST ENTRY SAYS WHICH SOURCE A TRANSLATION WAS MADE FROM, so a pull stamps one only with a
 * translation it writes. ⛔ Until 2026-10-17 every pull stamped the hash of the source it brought: a
 * translation the source had moved past came back current, and a manifest recorded under another
 * reading of an unchanged source was rewritten by a pull that changed nothing.
 */
describe('pull — the manifest of a free-form translation', () => {
  const MANIFEST = ['locales', 'freeform', 'es', '.manifest.json']
  const STORY = 'pages/about/story.md'

  // The author's copy: an English story, its Spanish free-form file, and the manifest entry recording
  // the source that translation was made from — then a pull of a document whose Spanish is `es`.
  function pullStory({ es, entry, manifestFile }) {
    ROOT = mkdtempSync(join(tmpdir(), 'uwx-freeform-manifest-'))
    const w = (rel, body) => {
      const p = join(ROOT, ...rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, body)
    }
    w(['site.yml'], 'name: Site\ndefaultLanguage: en\nfoundation: "@acme/fnd@1.0.0"\n')
    w(FREEFORM, 'Hola mundo\n')
    w(MANIFEST, manifestFile ?? JSON.stringify({ [STORY]: entry }, null, 2))
    const before = readFileSync(join(ROOT, ...MANIFEST), 'utf8')
    siteContentDocumentToProject({
      siteRoot: ROOT,
      document: {
        info: { name: 'Site' },
        settings: { languages: ['en', 'es'] },
        pages: [{
          stable_id: 'about', mode: 'page', slug: { en: 'about' }, title: { en: 'About' },
          page_sections: [{ stable_id: 'story', type: 'Section', content: { en: docOf('Hello world'), es } }],
        }],
      },
    })
    return { before, after: readFileSync(join(ROOT, ...MANIFEST), 'utf8') }
  }

  it('⭐ a translation the pull leaves as it is keeps its entry — one made from another source stays stale', () => {
    const entry = { hash: 'deadbeef', recorded: '2025-01-28' }
    expect(computeSourceHash(docOf('Hello world'))).not.toBe(entry.hash)
    const { before, after } = pullStory({ es: docOf('Hola mundo'), entry })
    expect(after).toBe(before)
  })

  it('a translation the pull writes is stamped with the source it came with', () => {
    const { after } = pullStory({ es: docOf('Hola mundo, editado'), entry: { hash: 'deadbeef', recorded: '2025-01-28' } })
    expect(readFileSync(join(ROOT, ...FREEFORM), 'utf8')).toBe('Hola mundo, editado\n')
    expect(JSON.parse(after)[STORY].hash).toBe(computeSourceHash(docOf('Hello world')))
  })

  it('one format for both writers — a manifest the pull changes is written as `saveManifest` writes it', async () => {
    const { after } = pullStory({ es: docOf('Hola mundo, editado'), entry: { hash: 'deadbeef', recorded: '2025-01-28' } })
    expect(after).toBe(manifestText(JSON.parse(after)))
    const dir = join(ROOT, 'locales', 'freeform', 'fr')
    await saveManifest(dir, JSON.parse(after))
    expect(readFileSync(join(dir, '.manifest.json'), 'utf8')).toBe(after)
  })
})
