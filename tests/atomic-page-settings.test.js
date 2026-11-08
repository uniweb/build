/**
 * ⭐ A PAGE THAT IS ONE `.md` FILE HOLDS ITS PAGE'S SETTINGS IN ITS FRONTMATTER (`src/site/page-settings.js`)
 * — on every lane: the build gives them to the page, the push sends them as the page's, and the pull writes
 * an app's change to them back into the file. A param named like one is written under `props:`.
 *
 * ⛔ Until 2026-11-08 they were the section's params: a manual's articles, each one file in folder mode,
 * built with no `<meta name="description">` while `uniweb doctor` told their author to put it in the
 * frontmatter, and a pull held any such page the app gave a description.
 *
 * And one rule for every page: a `page.yml`'s and a `folder.yml`'s `keywords:` reach a static build's page
 * as a push carries them (`pageSettingFields`). ⛔ Until 2026-11-08 the build read neither.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { buildRouteOf } from '../src/uwx/site.js'
import { collectSiteContent } from '../src/site/content-collector.js'
import { warnPageKeysNamingParams, ATOMIC_PAGE_KEYS } from '../src/site/page-settings.js'
import { isSectionKey } from '@uniweb/schemas/section'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const siteDir = () => join(ROOT, 'site')
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'atomic-page-settings-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const snapshot = () => {
  const files = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '.uniweb') continue
      if (statSync(p).isDirectory()) walk(p)
      else files[relative(ROOT, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(ROOT)
  return files
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort()
const pageAt = (doc, canon) => {
  const walk = (records, parent) => {
    for (const r of records || []) {
      const route = buildRouteOf(r, parent, 'en')
      if (route === canon) return r
      const found = walk(r.$children, route)
      if (found) return found
    }
    return null
  }
  return walk(doc.pages, '/')
}
const builtPage = async (route) => (await collectSiteContent(siteDir(), {})).pages.find((p) => p.route === route)

// A manual: a folder of pages, each article one `.md` file — the shape the feedback was about.
function manual() {
  w('site/site.yml', 'name: S\nfoundation: "@acme/base@1.0.0"\nindex: home\n')
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/hero.md', '# Welcome\n')
  w('site/pages/docs/folder.yml', 'title: Docs\n')
  w(
    'site/pages/docs/setting-up.md',
    [
      '---',
      'description: Set up your academy before your first student signs up.',
      'label: Setup',
      'keywords: [setup, academy]',
      'hideIn: [footer]',
      'layout: Wide',
      'seo:',
      '  ogTitle: Setting up your academy',
      'steps: true',
      '---',
      '',
      '# Setting up',
      '',
      'Begin here.',
      '',
    ].join('\n')
  )
  w('site/pages/docs/selling.md', '---\ntitle: Selling your courses\ntype: Article\n---\n\n# Selling\n\nYour store.\n')
}

describe('⭐ the build gives an atomic page its frontmatter\'s page settings', () => {
  it('the page takes them, and its section receives none of them as params', async () => {
    manual()
    const page = await builtPage('/docs/setting-up')
    expect(page).toMatchObject({
      title: 'Setting up', // its first heading: the frontmatter says none
      description: 'Set up your academy before your first student signs up.',
      label: 'Setup',
      keywords: ['setup', 'academy'],
      hideIn: ['footer'],
      layout: { name: 'Wide' },
      seo: { ogTitle: 'Setting up your academy' },
    })
    expect(page.sections[0].params).toEqual({ steps: true })
  })

  it('a `title:` names the page, over its first heading', async () => {
    manual()
    const page = await builtPage('/docs/selling')
    expect(page.title).toBe('Selling your courses')
    expect(page.sections[0]).toMatchObject({ type: 'Article', params: {} })
  })

  it('⭐ a param named like a page setting reaches the section under `props:`', async () => {
    manual()
    w('site/pages/docs/faq.md', '---\ndescription: Questions people ask.\nprops:\n  description: A short line under the title\n---\n\n# FAQ\n')
    const page = await builtPage('/docs/faq')
    expect(page.description).toBe('Questions people ask.')
    expect(page.sections[0].params).toEqual({ description: 'A short line under the title' })
  })

  it('in a page folder, the same keys in a section file stay that section\'s params', async () => {
    manual()
    w('site/pages/home/hero.md', '---\ndescription: The line under the title\n---\n\n# Welcome\n')
    const page = await builtPage('/')
    expect(page.description).toBe('')
    expect(page.sections[0].params).toEqual({ description: 'The line under the title' })
  })

  it('a section type with a param named like a page setting is warned about, with the file in hand', () => {
    const said = []
    warnPageKeysNamingParams({ label: 'Setup', description: 'x' }, 'Article', { Article: { params: { label: {} } } }, (m) => said.push(m))
    expect(said).toEqual([
      '`label:` is the page\'s label, since the page is this one file. Article has a `label` param too, ' +
        'which receives nothing: write it under `props:` to give it to the section (`props: { label: … }`).',
    ])
  })

  it('no page setting is a section key, so each is the page\'s or a param, never both', () => {
    expect(ATOMIC_PAGE_KEYS.filter((k) => isSectionKey(k))).toEqual([])
  })
})

describe('one rule for every page\'s settings (`pageSettingFields`)', () => {
  it('⭐ a page.yml\'s `keywords:` reaches the built page, as a push carries it', async () => {
    manual()
    w('site/pages/home/page.yml', 'title: Home\nkeywords: [courses, online]\n')
    expect((await builtPage('/')).keywords).toEqual(['courses', 'online'])
    expect(pageAt(await siteProjectToDocument(siteDir()), '/').keywords).toEqual([{ en: 'courses' }, { en: 'online' }])
  })

  it('a folder.yml\'s keywords and Open Graph title reach its page too', async () => {
    manual()
    w('site/pages/docs/folder.yml', 'title: Docs\nkeywords: [manual]\nseo:\n  ogTitle: The manual\n')
    expect(await builtPage('/docs')).toMatchObject({ keywords: ['manual'], seo: { ogTitle: 'The manual' } })
  })

  it('a page with no keywords carries none', async () => {
    manual()
    expect('keywords' in (await builtPage('/'))).toBe(false)
  })
})

describe('⭐ the push sends them as the page\'s', () => {
  it('as a page.yml\'s are sent, and the section\'s params leave them out', async () => {
    manual()
    const record = pageAt(await siteProjectToDocument(siteDir()), '/docs/setting-up')
    expect(record).toMatchObject({
      mode: 'atomic',
      title: { en: 'Setting up' },
      description: { en: 'Set up your academy before your first student signs up.' },
      label: { en: 'Setup' },
      hide_in: ['footer'],
      layout: 'Wide',
      seo: { ogTitle: 'Setting up your academy' },
    })
    expect(record.page_sections[0].params).toEqual({ steps: true })
    // Its identity stays its file's name: `id:` is the section's (`page-settings.js`).
    expect(record.$id).toBe('setting-up')
    expect(record.stable_id).toBeUndefined()
  })
})

describe('⭐ the pull writes them back into the file', () => {
  it('a pull of what was pushed changes no file', async () => {
    manual()
    const before = snapshot()
    siteContentDocumentToProject({ document: await siteProjectToDocument(siteDir()), siteRoot: siteDir(), prune: true })
    expect(changed(before, snapshot())).toEqual([])
  })

  it('a description the app gives a page lands in its frontmatter, held no longer, and the next push sends it', async () => {
    manual()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    pageAt(doc, '/docs/selling').description = { en: 'Sell what you teach.' }
    const report = siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(report.held).toEqual([])
    expect(changed(before, snapshot())).toEqual(['site/pages/docs/selling.md'])
    expect(read('site/pages/docs/selling.md')).toBe(
      '---\ntitle: Selling your courses\ntype: Article\ndescription: Sell what you teach.\n---\n\n# Selling\n\nYour store.\n'
    )
    expect(pageAt(await siteProjectToDocument(siteDir()), '/docs/selling').description).toEqual({ en: 'Sell what you teach.' })
  })

  it('a setting the app removes goes from the file, and a title back to its heading\'s is left out', async () => {
    manual()
    const doc = await siteProjectToDocument(siteDir())
    const setup = pageAt(doc, '/docs/setting-up')
    delete setup.label
    delete setup.hide_in
    const selling = pageAt(doc, '/docs/selling')
    selling.title = { en: 'Selling' }
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    const fm = read('site/pages/docs/setting-up.md')
    expect(fm).not.toContain('label:')
    expect(fm).not.toContain('hideIn:')
    expect(fm).toContain('description: Set up your academy')
    expect(read('site/pages/docs/selling.md')).toBe('---\ntype: Article\n---\n\n# Selling\n\nYour store.\n')
    expect((await builtPage('/docs/selling')).title).toBe('Selling')
  })

  it('⭐ a param the app gives the section, named like a page setting, is written under `props:` and comes back a param', async () => {
    manual()
    const doc = await siteProjectToDocument(siteDir())
    const setup = pageAt(doc, '/docs/setting-up')
    setup.page_sections[0].params = { steps: true, label: 'Step by step' }
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    const file = read('site/pages/docs/setting-up.md')
    expect(file).toContain('label: Setup\n')
    expect(file).toContain('props:\n  label: Step by step\n')
    const page = await builtPage('/docs/setting-up')
    expect(page.label).toBe('Setup')
    expect(page.sections[0].params).toEqual({ steps: true, label: 'Step by step' })
    // And it is stable: another pull of what the files now push changes nothing.
    const before = snapshot()
    siteContentDocumentToProject({ document: await siteProjectToDocument(siteDir()), siteRoot: siteDir(), prune: true })
    expect(changed(before, snapshot())).toEqual([])
  })

  it('a page the app adds to the folder comes back as one file holding its settings', async () => {
    manual()
    const doc = await siteProjectToDocument(siteDir())
    pageAt(doc, '/docs').$children.push({
      $id: 'marking', slug: { en: 'marking' }, mode: 'atomic', title: { en: 'Marking' },
      description: { en: 'How instructors mark written work.' },
      page_sections: [{ $id: 'marking', stable_id: 'marking', type: 'Article', content: { en: { type: 'doc', content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Marking' }] },
      ] } } }],
    })
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true, sectionType: 'Section' })

    expect(read('site/pages/docs/marking.md')).toBe('---\ndescription: How instructors mark written work.\ntype: Article\n---\n\n# Marking\n')
    expect((await builtPage('/docs/marking')).description).toBe('How instructors mark written work.')
  })
})

describe('a param named like a section key comes back under `props:`', () => {
  it('⛔ not over the section\'s own type, as it was written until 2026-11-08', async () => {
    manual()
    w('site/pages/home/hero.md', '---\ntype: Hero\nprops:\n  type: compact\n---\n\n# Welcome\n')
    const before = snapshot()
    siteContentDocumentToProject({ document: await siteProjectToDocument(siteDir()), siteRoot: siteDir(), prune: true })
    expect(changed(before, snapshot())).toEqual([])
    const doc = await siteProjectToDocument(siteDir())
    pageAt(doc, '/').page_sections[0].params = { type: 'wide' }
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })
    expect(read('site/pages/home/hero.md')).toBe('---\ntype: Hero\nprops:\n  type: wide\n---\n\n# Welcome\n')
  })
})
