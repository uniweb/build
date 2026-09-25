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
