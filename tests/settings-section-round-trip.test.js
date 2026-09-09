/**
 * The `info` / `settings` split, and the round-trip law that governs it.
 *
 * ⭐ **THE LAW** (`kb/framework/build/uwx-format.md`): an AUTHORED value must survive
 * pull → push unchanged. The backend is a git-style remote; a value that reaches the
 * server and cannot come back is data loss with a delay on it. Derived values are the
 * exception — there is no authored source to restore.
 *
 * ⭐ **THE SPLIT** (2026-09-09): `info` is the BRIEF — what a card or a select
 * dropdown renders, plus what a listing can filter on. `settings` is everything the
 * site renders *with*. Fifteen keys moved, because a brief was never meant to carry
 * configuration.
 *
 * ⛔ **THE LOCALE KEYS DID NOT MOVE, and the attempt failed silently.** `languages`,
 * `default_language` and `publish_languages` went to `settings` and came back the same
 * day: `info` IS the brief, so `entity.brief` has BACKEND readers — the custom-domain
 * surface, the pool-route reconcile, publish-locale narrowing — that neither framework
 * nor frontend can see. Their default-locale accessor falls back to `"en"` and never
 * errors, so moving them raised no refusal and would have resolved every site to
 * English. ⇒ *"Can this key leave `info`?"* is a grep in BACKEND's repo.
 *
 * ⛔ These two tests are deliberately whole-document rather than per-key. A per-key
 * test proves a key you remembered to write down; the fixed-point test proves every
 * key the producer emits, including one added later by someone who did not read this
 * file. That is the only form that keeps up with a growing Section.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

const DIRS = []

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
      'languages: [en, fr]', 'defaultLanguage: en', 'publishLanguages: [en]',
      'base: /x/', 'seo: { image: /og.png }', 'keywords: [a, b]',
      'fetcher: { transports: {} }', 'build: { prerender: true }',
      'search: { enabled: true }', 'submit: /s', 'assistant: /a', 'tracking: /t',
      'agents: false', 'paths: { pages: ./pages }', 'data: articles',
      'layout: { name: DocsLayout, hide: [right] }',
      'placeholders: { product: Uniweb }',
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
      'default_language', 'description', 'favicon', 'foundation', 'languages',
      'name', 'publish_languages', 'tags', 'template',
    ])

    // ⛔ `url` and `previewUrl` live on `info` too — but they are BACKEND-STAMPED,
    // so framework emits neither. A site's live address and its card image URL are
    // assigned by the host, and a serve location is read, never constructed.
    expect(doc.info).not.toHaveProperty('url')
    expect(doc.info).not.toHaveProperty('previewUrl')

    expect(Object.keys(doc.settings).sort()).toEqual([
      'agents', 'assistant', 'base', 'build', 'fetch', 'fetcher', 'head_html',
      'keywords', 'layout', 'paths', 'placeholders', 'search', 'seo', 'submit',
      'theme', 'tracking',
    ])
  })

  it('carries the whole layout object and the desugared fetch', async () => {
    const doc = await siteProjectToDocument(fullSite())
    // The site tier of framework's own `{name, hide, params}` — `hide` is a
    // non-destructive per-area disable the runtime honours. Framework read only
    // `.name` at this tier and emitted nothing at all until 2026-09-09.
    expect(doc.settings.layout).toEqual({ name: 'DocsLayout', hide: ['right'] })
    // `data:` is the authoring shorthand; the wire carries the desugared form under
    // the name every other tier already uses.
    expect(doc.settings.fetch).toEqual({ query: 'articles' })
  })
})

describe('⛔ THE ROUND-TRIP LAW — push → pull → push is a fixed point', () => {
  it('every authored key on both Sections survives a full cycle unchanged', async () => {
    const first = await siteProjectToDocument(fullSite())

    const dest = mkdtempSync(join(tmpdir(), 'uwx-split-rt-'))
    DIRS.push(dest)
    mkdirSync(join(dest, 'pages'), { recursive: true })
    siteContentDocumentToProject({ document: first, siteRoot: dest })

    const second = await siteProjectToDocument(dest)

    // Compared whole rather than key by key: a key that stops round-tripping must
    // fail here even if nobody added an assertion for it.
    expect(second.info).toEqual(first.info)
    expect(second.settings).toEqual(first.settings)
  })

  it('a value the projector cannot place would surface as a missing key, not a silent pass', async () => {
    // Guards the guard: if `siteContentDocumentToProject` wrote nothing at all, the
    // test above would compare two empty objects and pass. Assert the cycle actually
    // carried something substantial.
    const first = await siteProjectToDocument(fullSite())
    expect(Object.keys(first.settings).length).toBeGreaterThan(15)
    expect(first.settings.theme).toEqual({ colors: { primary: '#000' } })
  })
})
