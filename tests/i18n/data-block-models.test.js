/**
 * ⭐ A TAGGED DATA BLOCK IS TRANSLATED BY WHAT ITS SECTION TYPE DECLARES IT IS. A key whose shape a
 * `meta.js` declares — an inline field map or a data schema ref — translates the fields its model
 * marks `localized` and no others; a key with no shape keeps the heuristic. One rule for extraction,
 * the build's merge, the push and the pull (`data-models.js`, `data-strings.js::visitDataBlockStrings`).
 *
 * The case that raised it (2026-10-02): a sponsor block's `style: display-black` — a name the
 * component maps to classes — was offered for translation in 23 languages, because the heuristic
 * does not know a field called `style`, and a translated one fell back to the default look.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { dataBlockModels } from '../../src/i18n/data-models.js'
import { visitDataBlockStrings } from '../../src/i18n/data-strings.js'
import { extractTranslatableContent } from '../../src/i18n/extract.js'
import { mergeTranslations, resolveDocForLocale } from '../../src/i18n/merge.js'
import { unwrapLocalizedContent } from '../../src/uwx/locale-sync.js'
import { computeHash } from '../../src/i18n/hash.js'

let ROOT, SITE
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

// A site on a local foundation whose section types declare their data keys every way there is.
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uw-data-block-models-'))
  SITE = join(ROOT, 'site')
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  // `main` says where the source is: the flat layout, as a scaffold writes it.
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', `export default {
  name: '@acme/fnd',
  data: { promo: { headline: 'string', tone: { type: 'string', enum: ['calm', 'loud'] } } },
}\n`)
  const section = (name, meta) => {
    w(`fdn/sections/${name}/meta.js`, `export default ${meta}\n`)
    w(`fdn/sections/${name}/index.jsx`, `export default function ${name}() { return null }\n`)
  }
  // An inline field map: \`style\` is an enum, and \`status\` is text the heuristic would skip by name.
  section('LogoCloud', `{ title: 'Logos', data: { logos: { name: 'string', style: { type: 'string', enum: ['display-black', 'serif-italic'] }, status: 'string' } } }`)
  // A data schema ref.
  section('Team', `{ title: 'Team', data: { team: '@/member' } }`)
  w('fdn/schemas/member.yml', 'name: member\nfields:\n  name: { type: string }\n  role: { type: string, enum: [lead, member] }\n')
  // Keys with no shape — and one the foundation shapes, declared here without one.
  section('Plain', `{ title: 'Plain', data: { things: {}, promo: {} } }`)
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const LOGOS = [
  { name: 'TECHCORP', style: 'display-black', status: 'Founding partner' },
  { name: 'CivicTrust', style: 'serif-italic', status: 'New partner' },
]
const localized = (model) => Object.entries(model.sections.brief.fields).filter(([, f]) => f.localized).map(([n]) => n)

describe('dataBlockModels — the model of each declared key', () => {
  it('an inline field map: its text fields, never its enum', async () => {
    const model = (await dataBlockModels(SITE))('LogoCloud', 'logos')
    expect(localized(model)).toEqual(['name', 'status'])
  })

  it('a data schema ref, resolved as a query\'s records resolve theirs', async () => {
    const model = (await dataBlockModels(SITE))('Team', 'team')
    expect(localized(model)).toEqual(['name'])
  })

  it('the foundation\'s own keys reach every section — unless the section type declares the key itself', async () => {
    const models = await dataBlockModels(SITE)
    expect(localized(models('LogoCloud', 'promo'))).toEqual(['headline'])
    expect(models('Plain', 'promo')).toBeNull()
  })

  it('no shape, no model: an untyped key, an undeclared one, a type the foundation does not have', async () => {
    const models = await dataBlockModels(SITE)
    expect(models('Plain', 'things')).toBeNull()
    expect(models('LogoCloud', 'nothing')).toBeNull()
    expect(models('Extension', 'logos')).toBeNull()
  })

  it('CONTROL — a site with no foundation to ask keeps the heuristic everywhere', async () => {
    w('site/site.yml', 'name: T\n')
    expect((await dataBlockModels(SITE))('LogoCloud', 'logos')).toBeNull()
  })
})

describe('visitDataBlockStrings', () => {
  it('walks what the model marks text; with no model, the heuristic — which offers the enum', async () => {
    const model = (await dataBlockModels(SITE))('LogoCloud', 'logos')
    const seen = (m) => {
      const out = []
      visitDataBlockStrings(structuredClone(LOGOS), (value, path) => void out.push(`${path}=${value}`), m)
      return out
    }
    expect(seen(model)).toEqual(['[0].name=TECHCORP', '[0].status=Founding partner', '[1].name=CivicTrust', '[1].status=New partner'])
    expect(seen(null)).toEqual(['[0].name=TECHCORP', '[0].style=display-black', '[1].name=CivicTrust', '[1].style=serif-italic'])
  })
})

describe('the four walks agree', () => {
  const sectionDoc = () => markdownToProseMirror('# Our partners\n\n```yaml:logos\n' +
    LOGOS.map((l) => `- name: ${l.name}\n  style: ${l.style}\n  status: ${l.status}\n`).join('') + '```\n')
  const site = () => ({ config: { defaultLanguage: 'en' }, pages: [{ route: '/', sections: [{ id: 'logos', type: 'LogoCloud', content: sectionDoc() }] }] })
  const blockOf = (doc) => doc.content.find((n) => n.type === 'dataBlock').attrs.data

  it('extraction offers the names and the statuses, never a style', async () => {
    const units = Object.values(extractTranslatableContent(site(), { dataModel: await dataBlockModels(SITE) }).units).map((u) => u.source)
    expect(units).toEqual(expect.arrayContaining(['TECHCORP', 'Founding partner', 'New partner']))
    expect(units).not.toContain('display-black')
    // CONTROL — without the declaration, the heuristic offers the style and misses the status.
    const heuristic = Object.values(extractTranslatableContent(site()).units).map((u) => u.source)
    expect(heuristic).toContain('display-black')
    expect(heuristic).not.toContain('Founding partner')
  })

  it('the build never applies a translation to a style, even one the locale file holds', async () => {
    const table = { [computeHash('display-black')]: 'noir', [computeHash('Founding partner')]: 'Partenaire fondateur' }
    const block = blockOf(mergeTranslations(site(), table, { dataModel: await dataBlockModels(SITE) }).pages[0].sections[0].content)
    expect(block[0]).toEqual({ name: 'TECHCORP', style: 'display-black', status: 'Partenaire fondateur' })
  })

  it('a push translates the block as the build does, and a pull reads it back — the declared `status` too', async () => {
    const models = await dataBlockModels(SITE)
    const modelFor = (tag) => models('LogoCloud', tag)
    const table = { [computeHash('Founding partner')]: 'Partenaire fondateur', [computeHash('display-black')]: 'noir' }
    const source = sectionDoc()
    const fr = resolveDocForLocale(source, table, { page: '/', section: 'logos' }, modelFor)
    expect(blockOf(fr)[0]).toEqual({ name: 'TECHCORP', style: 'display-black', status: 'Partenaire fondateur' })

    const pulled = []
    const collector = { addStructuralMap: (locale, map) => pulled.push([locale, map]), noteFreeform: (locale) => pulled.push([locale, 'FREE-FORM']) }
    unwrapLocalizedContent({ en: source, fr }, 'en', collector, null, null, null, modelFor)
    expect(pulled).toEqual([['fr', { 'Founding partner': 'Partenaire fondateur' }]])

    // CONTROL — read back by the heuristic, which skips a field called `status`, the faithful
    // translation looks like another shape and is kept as a free-form body.
    const heuristic = []
    unwrapLocalizedContent({ en: source, fr }, 'en', { addStructuralMap: (l, m) => heuristic.push(m), noteFreeform: () => heuristic.push('FREE-FORM') })
    expect(heuristic).toEqual(['FREE-FORM'])
  })
})
