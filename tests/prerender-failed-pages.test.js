/**
 * ⛔ A PAGE THAT DOESN'T RENDER FAILS THE BUILD. Until 2026-11-02 it was a warning: a build ended
 * complete and exit 0 with pages missing from `dist/`, or an empty shell at `/`, and `uniweb deploy`
 * went on to ship that. An old docs foundation on a new kit lost 21 of its 22 pages this way, with
 * "Cannot convert undefined or null to object" as the only sign.
 *
 * The report has to say what to go and fix, so it names the section. `renderToString` names no
 * component, and a built foundation's stack names minified ones.
 *
 * This runs the build's own prerender over a site on disk.
 *
 * ⚠️ Reaches `@uniweb/runtime/ssr`, a BUILT artifact — rebuild it (`pnpm -C
 * framework/runtime build:ssr`) after changing the runtime, or this reads stale code.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { prerenderSite } from '../src/prerender.js'

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'

const section = (type, subsections = []) => ({ type, content: { type: 'doc', content: [] }, params: {}, subsections })

const page = (route, sections, extra = {}) => ({
  route,
  id: route === '/' ? 'home' : route.slice(1),
  title: route,
  isIndex: route === '/',
  sections,
  ...extra,
})

/** The foundation, as a built `entry.js`. React is imported by its resolved file, so the module loads from a temp directory. */
function foundationSource({ layoutThrows = false } = {}) {
  const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href
  return `
import React from ${JSON.stringify(react)}
const h = React.createElement
const Layout = ({ body }) => {
  ${layoutThrows ? "throw new Error('the layout broke')" : ''}
  return h('main', null, body)
}
export default {
  meta: { Plain: {}, Breaks: {}, Holds: {}, NeedsBrowser: {}, TwoReacts: {} },
  ${layoutThrows ? "capabilities: { layouts: { Layout }, defaultLayout: 'Layout' }," : ''}
}
export const Plain = () => h('p', null, 'Plain')
export const Breaks = () => { throw new Error('this section broke') }
export const Holds = ({ block }) => h('div', null, (block.childBlocks || []).map((child, i) => {
  const Component = child.initComponent()
  return h(Component, { key: i, content: {}, params: {}, block: child })
}))
export const NeedsBrowser = () => h('p', null, window.innerWidth)
export const TwoReacts = () => { throw new Error('Invalid hook call. Hooks can only be called inside of the body of a function component.') }
`
}

function project(pages, foundation = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prerender-failed-'))
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
  write('site/dist/index.html', SHELL)
  write('site/dist/site-content.json', { config: { name: 'T', defaultLanguage: 'en' }, theme: {}, pages })
  write('foundation/dist/entry.js', foundationSource(foundation))
  return root
}

async function build(pages, foundation) {
  const root = project(pages, foundation)
  const written = (route) => existsSync(join(root, 'site/dist', route, 'index.html'))
  try {
    const result = await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation') })
    return { result, error: null, written }
  } catch (error) {
    return { result: null, error, written }
  }
}

describe('a page that fails to render', () => {
  it('fails the build, and says which section on which page', async () => {
    const { error, written } = await build([page('/', [section('Plain')]), page('/about', [section('Plain'), section('Breaks')])])
    expect(error?.message).toContain("1 of 2 pages didn't render")
    expect(error.message).toContain('this section broke')
    expect(error.message).toContain('in section type Breaks')
    expect(error.message).toContain('on /about')
    // Every page has its turn, so the report names them all.
    expect(written('/')).toBe(true)
    expect(written('/about')).toBe(false)
  })

  it('says one thing once, however many pages it stopped', async () => {
    const routes = ['/a', '/b', '/c', '/d', '/e']
    const { error } = await build(routes.map((route) => page(route, [section('Breaks')])))
    expect(error.message).toContain("5 of 5 pages didn't render")
    expect(error.message).toContain('on /a, /b, /c and 2 more')
    expect(error.message.match(/this section broke/g)).toHaveLength(1)
  })

  it('names each of two different failures', async () => {
    const { error } = await build([page('/a', [section('Breaks')]), page('/b', [section('NeedsBrowser')])])
    expect(error.message).toContain('in section type Breaks')
    expect(error.message).toContain('in section type NeedsBrowser')
  })

  it('names the section inside the one that holds it', async () => {
    const { error } = await build([page('/', [section('Holds', [section('Plain'), section('Breaks')])])])
    expect(error.message).toContain('in section type Breaks')
  })

  it('says so when every section renders alone, so it is the layout', async () => {
    const { error } = await build([page('/', [section('Plain')])], { layoutThrows: true })
    expect(error.message).toContain('the layout broke')
    expect(error.message).toContain('in the layout')
  })

  it("says what to do about code that needs a browser, which a build hasn't got", async () => {
    const { error } = await build([page('/', [section('NeedsBrowser')])])
    expect(error.message).toContain('window is not defined')
    expect(error.message).toContain('inside useEffect')
  })
})

describe('a build with nothing wrong', () => {
  it('reports its pages and no failure', async () => {
    const { result, error, written } = await build([page('/', [section('Plain')]), page('/about', [section('Plain')])])
    expect(error).toBe(null)
    expect(result.pages).toBe(2)
    expect(result.skipped).toEqual([])
    expect(written('/about')).toBe(true)
  })

  it('leaves a page to the browser when the error says it can render there, and says which', async () => {
    const { result, error, written } = await build([page('/', [section('Plain')]), page('/hooks', [section('TwoReacts')])])
    expect(error).toBe(null)
    expect(result.pages).toBe(1)
    expect(result.skipped).toEqual(['/hooks'])
    expect(written('/hooks')).toBe(false)
  })
})
