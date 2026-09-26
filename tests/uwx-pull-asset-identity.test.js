/**
 * ⭐ A PULL INTO THE COPY THAT PUSHED LEAVES AN IMAGE AS THE AUTHOR WROTE IT — the path, and nothing
 * beside it.
 *
 * Measured 2026-09-26 on the `international` template: a pull into the copy that pushed it put each
 * hero background's path back and wrote the identity the push stamps beside it (`assetId`,
 * `assetExt`) into the section's frontmatter. The id of an asset the project holds is kept in
 * `sync.json`, and the push stamps it from there.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { siteContentDocumentToProject, restoreAssetRefs } from '../src/uwx/index.js'

const BACKEND = 'http://localhost:8080'
const ID = 'c2194cfee53efb781a6e2790fe67b5c6'
const SERVED = `/assets/${ID}.jpg`
const BODY = '# Welcome\n![Team](/images/hero.jpg)\nWe study pandas.'

let SITE
afterEach(() => {
  if (SITE) rmSync(SITE, { recursive: true, force: true })
  SITE = undefined
})

// The document as the backend returns it: every reference to the image as the push sent it — the
// serve URL, with the identity beside it. A fresh one per pull, since a pull mutates it.
function pulled() {
  const content = markdownToProseMirror(BODY.replace('/images/hero.jpg', SERVED))
  const stamp = (node) => {
    if (node?.type === 'image') Object.assign(node.attrs, { assetId: ID, assetExt: 'jpg' })
    node?.content?.forEach(stamp)
  }
  stamp(content)
  return {
    info: { name: 'Site' },
    pages: [{
      $id: 'home', slug: { en: 'home' }, mode: 'page', stable_id: 'home', title: { en: 'Home' }, is_index: true,
      page_sections: [{
        $id: 'hero', stable_id: 'hero', type: 'Hero', content,
        background: { image: { src: SERVED, assetId: ID, assetExt: 'jpg' } },
      }],
    }],
  }
}

function pull(assets, section = {}) {
  SITE = SITE || mkdtempSync(join(tmpdir(), 'uwx-pull-assets-'))
  writeFileSync(join(SITE, 'site.yml'), 'name: Site\nindex: home\n')
  writeFileSync(join(SITE, 'sync.json'), JSON.stringify({ version: 1, backends: { [BACKEND]: { assets } } }))
  const document = pulled()
  Object.assign(document.pages[0].page_sections[0], section)
  return siteContentDocumentToProject({ document, siteRoot: SITE, backend: BACKEND })
}

const AUTHORED = `---\ntype: Hero\nbackground:\n  image:\n    src: /images/hero.jpg\nid: hero\n---\n\n${BODY}\n`

describe('pull — an image the project holds', () => {
  it('⭐ comes back as the author wrote it, in the frontmatter and in the body', () => {
    SITE = mkdtempSync(join(tmpdir(), 'uwx-pull-assets-'))
    mkdirSync(join(SITE, 'pages/home'), { recursive: true })
    writeFileSync(join(SITE, 'pages/home/hero.md'), AUTHORED)
    pull({ '/images/hero.jpg': { id: ID, ext: 'jpg' } })
    // The pull addressed this file, and left it as it was.
    expect(readdirSync(join(SITE, 'pages/home')).filter((f) => f.endsWith('.md'))).toEqual(['hero.md'])
    expect(readFileSync(join(SITE, 'pages/home/hero.md'), 'utf8')).toBe(AUTHORED)
  })

  it('⭐ a body holding it compares as unchanged, and is left byte for byte', () => {
    // The author's markdown parses with no id, so a body whose image kept one never matched.
    const authored = `---\ntype: Hero\nid: hero\n---\n\n${BODY}\n`
    SITE = mkdtempSync(join(tmpdir(), 'uwx-pull-assets-'))
    mkdirSync(join(SITE, 'pages/home'), { recursive: true })
    writeFileSync(join(SITE, 'pages/home/hero.md'), authored)
    pull({ '/images/hero.jpg': { id: ID, ext: 'jpg' } }, { background: undefined })
    expect(readFileSync(join(SITE, 'pages/home/hero.md'), 'utf8')).toBe(authored)
  })

  it('CONTROL — an asset the project does not hold keeps its URL and its identity', () => {
    pull({})
    const text = readFileSync(join(SITE, 'pages/home/hero.md'), 'utf8')
    expect(text).toContain(`src: ${SERVED}`)
    expect(text).toContain(`assetId: ${ID}`)
  })
})

describe('restoreAssetRefs — the identity goes with the URL', () => {
  it('⭐ a restored reference drops the identity stamped beside it', () => {
    const node = { src: SERVED, assetId: ID, assetExt: 'jpg', alt: 'Team' }
    restoreAssetRefs(node, { '/images/hero.jpg': { id: ID, ext: 'jpg' } })
    expect(node).toEqual({ src: '/images/hero.jpg', alt: 'Team' })
  })

  it('a poster restored alone drops only its own identity', () => {
    const node = { src: 'https://cdn/clip.mp4', assetId: 'UNSEEN', poster: '/served/p.png', posterAssetId: ID, posterAssetExt: 'png' }
    restoreAssetRefs(node, { '/images/poster.png': { id: ID, ext: 'png' } })
    expect(node).toEqual({ src: 'https://cdn/clip.mp4', assetId: 'UNSEEN', poster: '/images/poster.png' })
  })
})
