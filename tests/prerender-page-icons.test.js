/**
 * ⭐ A BUILT PAGE DRAWS THE ICONS ITS SITE NAMES, not only the image icons of its content.
 *
 * A static build fetches the whole site's content icons once (`prefetchIcons`) and every page
 * embeds them. An icon named anywhere else — a link's `icon`, a param, a tagged data block, a record
 * such as a service's `icon` — is the page's data step's to fetch (`loadPageData`, `icons: true`),
 * and the page carries it beside the site's, so the browser's first render draws what the build drew.
 * ⛔ Until 2026-11-04 the step was told `icons: false`, and each such icon was a blank box in the
 * built page until the browser fetched it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { prerenderSite } from '../src/prerender.js'

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'
const BASE = 'https://icons.example.test'
const svg = (name) => `<svg viewBox="0 0 24 24"><title>${name}</title></svg>`
const SERVICES = [
  { $name: 'maternity', title: 'Maternity', icon: 'lu-baby' },
  { $name: 'emergency', title: 'Emergency', icon: 'lu-siren' },
]

const doc = (...nodes) => ({ type: 'doc', content: [{ type: 'paragraph', content: nodes }] })
const icon = (name) => ({ type: 'image', attrs: { role: 'icon', library: 'lu', name } })
const section = (type, content = doc()) => ({ type, content, params: {} })

function siteContent({ pages = [] } = {}) {
  return {
    config: {
      name: 'T',
      defaultLanguage: 'en',
      icons: { base: BASE },
      queries: {
        services: { schema: '@/service', path: '/data/services.json' },
        extras: { schema: '@/service', path: '/data/extras.json' },
      },
    },
    theme: {},
    // What the content collector found: the image icons of the site's content.
    icons: { used: ['lu:house'] },
    pages: [
      { route: '/', id: 'home', isIndex: true, title: 'Home', sections: [section('Plain', doc(icon('house')))] },
      { route: '/services', id: 'services', title: 'Services', fetch: { query: 'services', as: 'services' }, sections: [section('Services')] },
      ...pages,
    ],
  }
}

/** A built `entry.js`. `Services` draws each record's icon as kit's `<Icon>` does on the server. */
function foundationSource() {
  const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href
  return `
import React from ${JSON.stringify(react)}
const h = React.createElement
export default { meta: { Plain: {}, Services: { data: { services: null } } } }
export const Plain = () => h('p', null, 'Plain')
export const Services = ({ content }) =>
  h('ul', null, (content.data.services || []).map((r) => {
    const drawn = globalThis.uniweb.getIconSync('lu', r.icon.slice(3))
    return h('li', { key: r.$name, 'data-icon': drawn ? 'drawn' : 'blank' }, r.title)
  }))
`
}

function project({ services = SERVICES, extras = [], pages } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prerender-icons-'))
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
  write('site/public/data/services.json', services)
  write('site/public/data/extras.json', extras)
  write('site/dist/index.html', SHELL)
  write('site/dist/site-content.json', siteContent({ pages }))
  write('foundation/dist/entry.js', foundationSource())
  return root
}

const page = (root, route) => readFileSync(join(root, 'site/dist', route === '/' ? '' : route, 'index.html'), 'utf8')
const carried = (html) => Object.keys(JSON.parse(html.match(/<script id="__ICON_CACHE__"[^>]*>([\s\S]*?)<\/script>/)[1]))

describe('a built page draws the icons its site names', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function build() {
    const asked = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      asked.push(String(url))
      const name = String(url).match(/\/lu\/lu-([a-z0-9-]+)\.svg$/)?.[1]
      return name ? new Response(svg(name), { status: 200 }) : new Response('not found', { status: 404 })
    }))
    const root = project()
    await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation') })
    return { root, asked }
  }

  it('⭐ draws a record’s icon, and carries it after the site’s content icons', async () => {
    const { root } = await build()
    try {
      const services = page(root, '/services')
      expect(services).toContain('<li data-icon="drawn">Maternity</li>')
      expect(services).toContain('<li data-icon="drawn">Emergency</li>')
      // The site's first, then what this page drew, in key order: the same page every build.
      expect(carried(services)).toEqual(['lu:house', 'lu:baby', 'lu:siren'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('…while a page that draws none carries the site’s alone', async () => {
    const { root } = await build()
    try {
      expect(carried(page(root, '/'))).toEqual(['lu:house'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('asks for each icon once in a build', async () => {
    const { root, asked } = await build()
    try {
      const icons = asked.filter((url) => url.endsWith('.svg')).sort()
      expect(icons).toEqual([`${BASE}/lu/lu-baby.svg`, `${BASE}/lu/lu-house.svg`, `${BASE}/lu/lu-siren.svg`])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * ⭐ …AND ASKS FOR EACH ONE ONCE, ANSWERED OR NOT. An icon that never arrives would otherwise be
 * asked again by every page naming it, and one the network drops costs each of those pages the
 * step's whole wait (`iconAsker`). Two pages here draw the same records, one naming an icon the
 * corpus lacks and one naming an icon whose request never answers.
 */
describe('a build asks for each icon once, answered or not', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('⭐ asks once for an icon the corpus lacks and once for one that never answers', async () => {
    const asked = []
    vi.stubGlobal('fetch', vi.fn((url) => {
      asked.push(String(url))
      if (String(url).endsWith('/lu-silent.svg')) return new Promise(() => {})
      const name = String(url).match(/\/lu\/lu-([a-z0-9-]+)\.svg$/)?.[1]
      return Promise.resolve(name && name !== 'nameless'
        ? new Response(svg(name), { status: 200 })
        : new Response('not found', { status: 404 }))
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = project({
      services: [
        ...SERVICES,
        { $name: 'lab', title: 'Lab', icon: 'lu-nameless' },
        { $name: 'night', title: 'Night', icon: 'lu-silent' },
      ],
      pages: [{ route: '/more', id: 'more', title: 'More', fetch: { query: 'services', as: 'services' }, sections: [section('Services')] }],
    })
    try {
      await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation') })
      const count = (name) => asked.filter((url) => url === `${BASE}/lu/lu-${name}.svg`).length
      expect(count('nameless')).toBe(1)
      expect(count('silent')).toBe(1)
      for (const route of ['/services', '/more']) {
        const html = page(root, route)
        expect(html).toContain('<li data-icon="drawn">Maternity</li>')
        expect(html).toContain('<li data-icon="blank">Lab</li>')
        expect(html).toContain('<li data-icon="blank">Night</li>')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * ⭐ …AND NEVER WAITS FOR THE CORPUS TWICE. A request from an earlier page still on its way when the
 * next page starts says the corpus answers slower than the step waits, so the build asks it nothing
 * more and says so once (`iconAsker`), and a later page's new icon is the browser's to fetch.
 */
describe('a build that meets an icon corpus slower than a page waits', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('⭐ stops asking it, says so once, and leaves the later pages’ new icons for the browser', async () => {
    const asked = []
    let silent = null
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      asked.push(String(url))
      if (String(url).endsWith('/lu-silent.svg')) {
        silent = init?.signal
        return new Promise((_, reject) => silent?.addEventListener('abort', () => reject(silent.reason)))
      }
      const name = String(url).match(/\/lu\/lu-([a-z0-9-]+)\.svg$/)?.[1]
      return Promise.resolve(name ? new Response(svg(name), { status: 200 }) : new Response('', { status: 404 }))
    }))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = project({
      services: [...SERVICES, { $name: 'night', title: 'Night', icon: 'lu-silent' }],
      extras: [{ $name: 'garden', title: 'Garden', icon: 'lu-leaf' }],
      pages: [{ route: '/extra', id: 'extra', title: 'Extra', fetch: { query: 'extras', as: 'services' }, sections: [section('Services')] }],
    })
    try {
      await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation') })
      expect(asked.filter((url) => url.endsWith('/lu-leaf.svg'))).toEqual([])
      expect(page(root, '/extra')).toContain('<li data-icon="blank">Garden</li>')
      // What the corpus answered before it fell silent is still drawn.
      expect(page(root, '/services')).toContain('<li data-icon="drawn">Maternity</li>')
      const slow = warned.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('slower than a page waits'))
      expect(slow).toHaveLength(1)
      // …and what it stopped waiting for is abandoned, so it holds nothing open.
      expect(silent?.aborted).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
