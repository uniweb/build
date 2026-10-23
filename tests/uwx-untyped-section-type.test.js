/**
 * ⭐ A SECTION WHOSE FILE NAMES NO TYPE IS SENT THE TYPE IT RENDERS WITH — its foundation's
 * `defaultSection`, else `Section` (`@uniweb/core/section-type`, the rule the site's own render
 * asks), so a host rendering what the store holds renders what the files render. A pull leaves that
 * type out of the file again.
 *
 * ⛔ Until 2026-10-23 a push sent `Content`, which no starter template's foundation has. Measured
 * that day on a documentation site: every page of its mounted docs folder read "Component not
 * found: Content" on the hosted site, while a local build of the same files rendered `Section`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument, siteContentDocumentToProject, siteDefaultSectionType } from '../src/uwx/index.js'

let ROOT, SITE
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-untyped-section-'))
  SITE = join(ROOT, 'site')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

// A site on a LOCAL foundation — `foundation: fnd`, a `file:` dependency — with one typed section,
// one section that names no type, and a layout section that names none.
function makeSite({ main = "export default { name: '@acme/fnd' }\n" } = {}) {
  w('site/site.yml', 'name: T\nfoundation: fnd\nindex: home\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/pages/home/1-hero.md', '---\ntype: Hero\n---\n\n# Home\n')
  w('site/pages/home/2-body.md', '## Plain\n\nNo type named.\n')
  w('site/layout/footer.md', 'All rights reserved.\n')
  // `main` says where the source is (`foundation-source-root.js`): here, beside package.json.
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', main)
}

const homeSections = (doc) => doc.pages.find((p) => p.slug?.en === 'home').page_sections
const typeOf = (records, id) => records.find((r) => r.$id === id)?.type
const frontmatterType = (rel) => readFileSync(join(SITE, rel), 'utf8').match(/^type: (.+)$/m)?.[1] ?? null

describe('push — a section whose file names no type', () => {
  it('is sent Section when the foundation declares no default — what the runtime renders it with', async () => {
    makeSite()
    expect(await siteDefaultSectionType(SITE)).toBe('Section')
    const doc = await siteProjectToDocument(SITE)
    expect(typeOf(homeSections(doc), 'hero')).toBe('Hero')
    expect(typeOf(homeSections(doc), 'body')).toBe('Section')
    expect(doc.layout_sections.map((s) => s.type)).toEqual(['Section'])
  })

  it("is sent the foundation's defaultSection when it declares one", async () => {
    makeSite({ main: "export default { name: '@acme/fnd', defaultSection: 'Prose' }\n" })
    expect(await siteDefaultSectionType(SITE)).toBe('Prose')
    const doc = await siteProjectToDocument(SITE)
    expect(typeOf(homeSections(doc), 'hero')).toBe('Hero')
    expect(typeOf(homeSections(doc), 'body')).toBe('Prose')
    expect(doc.layout_sections.map((s) => s.type)).toEqual(['Prose'])
  })

  it('is never sent the retired filler, Content', async () => {
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    expect(JSON.stringify(doc)).not.toMatch(/"type":"Content"/)
  })
})

describe('pull — the implied type stays out of the file', () => {
  it('leaves a file that names no type without one, and writes any other stored type', async () => {
    makeSite()
    const doc = await siteProjectToDocument(SITE)

    siteContentDocumentToProject({ document: doc, siteRoot: SITE, sectionType: 'Section' })
    expect(frontmatterType('pages/home/2-body.md')).toBeNull()
    expect(frontmatterType('pages/home/1-hero.md')).toBe('Hero')

    // An editor gave the section a type: that one is the store's, and the file says it.
    homeSections(doc).find((r) => r.$id === 'body').type = 'Hero'
    siteContentDocumentToProject({ document: doc, siteRoot: SITE, sectionType: 'Section' })
    expect(frontmatterType('pages/home/2-body.md')).toBe('Hero')
  })

  it('CONTROL — the type it leaves out is the one it is handed, not a constant', async () => {
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    siteContentDocumentToProject({ document: doc, siteRoot: SITE, sectionType: 'Prose' })
    expect(frontmatterType('pages/home/2-body.md')).toBe('Section')
  })
})
