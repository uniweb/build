/**
 * The `info` / `settings` split, and the round-trip law that governs it.
 *
 * ⭐ **THE LAW**: an AUTHORED value must survive
 * pull → push unchanged. The backend is a git-style remote; a value that reaches the
 * server and cannot come back is data loss with a delay on it. Derived values are the
 * exception — there is no authored source to restore.
 *
 * ⭐ **THE SPLIT** (2026-09-09): `info` is the BRIEF — what a card or a select
 * dropdown renders, plus what a listing can filter on. `settings` is everything the
 * site renders *with*. Fourteen keys moved, because a brief was never meant to carry
 * configuration.
 *
 * ⚠️ **THE LOCALE KEYS MOVED, REVERTED AND MOVED AGAIN IN ONE DAY.** Backend refused
 * the move — three call sites read them off `entity.brief`, and their default-locale
 * accessor falls back to `"en"` without erroring, so the failure would have been
 * SILENT. Framework reverted. ⭐ The constraint had already been lifted when the
 * refusal was written: backend had reworked those readers to take the stored Item
 * through a name-keyed accessor, then made the move, and did not withdraw the refusal.
 * ⇒ *"Can this key leave `info`?"* is still a grep in BACKEND's repo — and a refusal
 * has a date on it, like any other measurement.
 *
 * ⛔ These two tests are deliberately whole-document rather than per-key. A per-key
 * test proves a key you remembered to write down; the fixed-point test proves every
 * key the producer emits, including one added later by someone who did not read this
 * file. That is the only form that keeps up with a growing Section.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

const DIRS = []

// A deployment whose `settings` declares every key this producer can emit — so the keys sent only
// where a deployment takes them (`touch_icon`) are in the cycle too.
const SURFACE = JSON.parse(readFileSync(new URL('../src/uwx/emit-surface.json', import.meta.url), 'utf8'))
const TAKES_ALL = { settingsFields: Object.keys(SURFACE.sections.settings.keys) }

/** A site declaring one of everything framework emits. */
function fullSite() {
  const root = mkdtempSync(join(tmpdir(), 'uwx-split-'))
  DIRS.push(root)
  mkdirSync(join(root, 'pages', 'home'), { recursive: true })
  writeFileSync(join(root, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# H\n')
  writeFileSync(join(root, 'theme.yml'), 'colors:\n  primary: "#000"\n')
  writeFileSync(join(root, 'head.html'), '<meta name="x" content="y">\n')
  writeFileSync(
    join(root, 'site.yml'),
    [
      "name: S", "foundation: '@a/b@1.0.0'", 'description: D', 'favicon: /f.svg',
      'template: true', 'tags: [academic, portfolio]',
      'preview: /images/card.png',
      'languages: [en, fr]', 'defaultLanguage: en', 'publishLanguages: [en]',
      'base: /x/', 'seo: { image: /og.png }', 'keywords: [a, b]',
      'fetcher: { transports: {} }', 'build: { prerender: true }',
      'services: { search: { include: { lists: false } }, submit: /s, assistant: /a, tracking: /t }',
      'agents: false', 'paths: { pages: ./pages }', 'query: articles',
      'layout: { name: DocsLayout, hide: [right] }',
      'placeholders: { product: Uniweb }',
      'touchIcon: /touch-icon.png',
      '',
    ].join('\n')
  )
  return root
}

afterEach(() => {
  while (DIRS.length) rmSync(DIRS.pop(), { recursive: true, force: true })
})

describe('the info / settings split', () => {
  it('puts the card on `info` and the configuration on `settings`', async () => {
    const doc = await siteProjectToDocument(fullSite())

    // ⭐ `info` is a BRIEF. Everything here is rendered on a card or filtered on:
    // a title, a subtitle, an icon, a "this is a template" badge, the facets, and
    // the foundation that says what the thing is.
    expect(Object.keys(doc.info).sort()).toEqual([
      'description', 'favicon', 'foundation', 'name', 'preview', 'tags', 'template',
    ])

    // ⭐ `preview` (the card image) is carried and round-trips [Diego, 2026-09-10] — an
    // author's address, the only kind sent since 2026-10-29 (below). Until 2026-09-10 this
    // asserted framework did NOT emit it, which let every push destroy an app-written
    // value, because `info` is replaced whole. (`url` rode beside it until 2026-09-17 and
    // is retired — uwx-site-project.test.js.)
    expect(doc.info.preview).toBe('/images/card.png')

    // ⚠️ THE SPELLING IS LOAD-BEARING. These are the Model's earlier names for the
    // card image (`preview_url`, then `preview_image` until generation 19) plus one it
    // never had (`previewUrl`, asserted here until 2026-09-09 and so guarding nothing).
    // A guard aimed at a dead name passes forever; emitting any of these is a bug.
    for (const dead of ['preview_image', 'preview_url', 'previewUrl']) {
      expect(doc.info).not.toHaveProperty(dead)
    }

    expect(Object.keys(doc.settings).sort()).toEqual([
      'agents', 'base', 'build', 'default_language', 'fetch', 'fetcher',
      'head_html', 'keywords', 'languages', 'layout', 'paths', 'placeholders',
      'publish_languages', 'seo', 'theme',
    ])
    // …and where the deployment takes it, the touch icon beside them.
    const taken = await siteProjectToDocument(fullSite(), TAKES_ALL)
    expect(Object.keys(taken.settings).filter((k) => !(k in doc.settings))).toEqual(['touch_icon'])
    expect(taken.settings.touch_icon).toBe('/touch-icon.png')

    // ⭐ A service rides its row, whole — never `settings` (`search`, `submit`,
    // `assistant` and `tracking` sat there until the evening of 2026-10-06).
    expect(doc.services.map(({ $id: _id, ...row }) => row)).toEqual([
      { name: 'search', config: { include: { lists: false } } },
      { name: 'submit', enabled: false, config: { endpoint: '/s' } },
      { name: 'assistant', enabled: false, config: { endpoint: '/a' } },
      { name: 'tracking', enabled: false, config: { endpoint: '/t' } },
    ])
  })

  it('carries the whole layout object and the desugared fetch', async () => {
    const doc = await siteProjectToDocument(fullSite())
    // The site tier of framework's own `{name, hide, params}` — `hide` is a
    // non-destructive per-area disable the runtime honours. Framework read only
    // `.name` at this tier and emitted nothing at all until 2026-09-09.
    expect(doc.settings.layout).toEqual({ name: 'DocsLayout', hide: ['right'] })
    // `query:` is the authoring shorthand; the wire carries the desugared form under
    // the name every other tier already uses.
    expect(doc.settings.fetch).toEqual({ query: 'articles' })
  })
})

describe('⛔ THE ROUND-TRIP LAW — push → pull → push is a fixed point', () => {
  it('every authored key on both Sections survives a full cycle unchanged', async () => {
    const first = await siteProjectToDocument(fullSite(), TAKES_ALL)

    const dest = mkdtempSync(join(tmpdir(), 'uwx-split-rt-'))
    DIRS.push(dest)
    mkdirSync(join(dest, 'pages'), { recursive: true })
    siteContentDocumentToProject({ document: first, siteRoot: dest })

    const second = await siteProjectToDocument(dest, TAKES_ALL)

    // Compared whole rather than key by key: a key that stops round-tripping must
    // fail here even if nobody added an assertion for it.
    expect(second.info).toEqual(first.info)
    expect(second.settings).toEqual(first.settings)
    expect(second.services).toEqual(first.services)
  })

  it('a value the projector cannot place would surface as a missing key, not a silent pass', async () => {
    // Guards the guard: if `siteContentDocumentToProject` wrote nothing at all, the
    // test above would compare two empty objects and pass. Assert the cycle actually
    // carried something substantial.
    const first = await siteProjectToDocument(fullSite(), TAKES_ALL)
    expect(Object.keys(first.settings).length).toBeGreaterThanOrEqual(16)
    expect(first.services.length).toBe(4)
    expect(first.settings.theme).toEqual({ colors: { primary: '#000' } })
    expect(first.settings.touch_icon).toBe('/touch-icon.png')
  })

})

// ⭐ `preview` IS AN AUTHOR'S ADDRESS OR NOTHING (2026-10-29). Until then the app recorded a card
// image it generated as an opaque token in this field, and the token rode every push and pull so
// that a push would not erase it. That record is kept apart from the site's content now, so the
// token an older pull left in a site.yml is not sent, and a pull removes it.
describe("`preview` — an author's address, and only that", () => {
  // Some tokens are also YAML numbers or dates: unquoted, `3e451234` loads as Infinity.
  const TOKENS = ["'3e451234'", '20260910', "'2026-09-10T12:34:56Z'", '2026-09-10T12:34:56Z']
  const ADDRESSES = ['/images/card.png', 'images/card.png', 'https://cdn.example/card.png']

  /** A pull of a document that carries no `preview`, into a copy whose site.yml holds `preview`. */
  async function pullInto(preview) {
    const document = await siteProjectToDocument(fullSite())
    delete document.info.preview
    const dest = mkdtempSync(join(tmpdir(), 'uwx-split-preview-'))
    DIRS.push(dest)
    mkdirSync(join(dest, 'pages'), { recursive: true })
    writeFileSync(join(dest, 'site.yml'), `# the card\nname: S\npreview: ${preview}\n`)
    siteContentDocumentToProject({ document, siteRoot: dest })
    return readFileSync(join(dest, 'site.yml'), 'utf8')
  }

  it('a push sends no token, whatever YAML reads it as', async () => {
    for (const token of TOKENS) {
      const src = fullSite()
      writeFileSync(join(src, 'site.yml'), `name: S\nfoundation: '@a/b@1.0.0'\npreview: ${token}\n`)
      expect((await siteProjectToDocument(src)).info, token).not.toHaveProperty('preview')
    }
  })

  it('a push sends an address as the author wrote it', async () => {
    for (const address of ADDRESSES) {
      const src = fullSite()
      writeFileSync(join(src, 'site.yml'), `name: S\nfoundation: '@a/b@1.0.0'\npreview: ${address}\n`)
      expect((await siteProjectToDocument(src)).info.preview).toBe(address)
    }
  })

  it("a pull that brings no `preview` removes a token, and keeps the file's other lines", async () => {
    for (const token of TOKENS) {
      const after = await pullInto(token)
      expect(yaml.load(after), token).not.toHaveProperty('preview')
      expect(after.startsWith('# the card\nname: S\n'), after).toBe(true)
    }
  })

  it("a pull that brings no `preview` keeps an author's address", async () => {
    for (const address of ADDRESSES) {
      expect(yaml.load(await pullInto(address)).preview).toBe(address)
    }
  })
})
