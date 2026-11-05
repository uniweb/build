/**
 * A section type's `area:` — `true` for any layout area, an area's name, or a list of names
 * (2026-11-05). The build refuses a malformed one, naming the component, and warns when a name is
 * one none of the foundation's layouts draws; the entry carries it as written, for an editor.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverComponents, reportAreaNames } from '../src/schema.js'

function foundationWith(meta) {
  const dir = mkdtempSync(join(tmpdir(), 'area-'))
  mkdirSync(join(dir, 'sections', 'Header'), { recursive: true })
  writeFileSync(join(dir, 'sections', 'Header', 'index.jsx'), 'export default () => null\n')
  writeFileSync(join(dir, 'sections', 'Header', 'meta.js'), `export default ${JSON.stringify(meta)}\n`)
  return dir
}

function warningsOf(run) {
  const saved = console.warn
  const warned = []
  console.warn = (message) => warned.push(String(message))
  try {
    run()
  } finally {
    console.warn = saved
  }
  return warned
}

describe("a section type's area", () => {
  it('a malformed one stops the build, naming the component', async () => {
    for (const area of ['', [], 3, { header: true }]) {
      const dir = foundationWith({ area })
      try {
        await expect(discoverComponents(dir)).rejects.toThrow(/Header \(meta\.js\): Invalid 'area'/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('CONTROL — a name or a list reaches the schema entry as written, for an editor', async () => {
    const dir = foundationWith({ area: ['left', 'right'] })
    try {
      const components = await discoverComponents(dir)
      expect(components.Header.area).toEqual(['left', 'right'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('an area no layout draws', () => {
  const layouts = { DocsLayout: { name: 'DocsLayout', areas: ['header', 'footer', 'left'] } }
  const asDefault = { defaultLayout: 'DocsLayout' }

  it('⭐ is warned, naming the type, the area and the areas the layouts draw', () => {
    const warned = warningsOf(() => reportAreaNames({ Nav: { area: ['left', 'right'] }, Header: { area: 'header' } }, layouts, asDefault))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/^Warning: Nav \(meta\.js\): area names "right", which no layout of this foundation draws \(they draw header, footer, left\)/)
  })

  it('CONTROL — names every layout draws, and `true`, say nothing', () => {
    expect(warningsOf(() => reportAreaNames({ Header: { area: 'header' }, Any: { area: true }, Hero: {} }, layouts, asDefault))).toEqual([])
  })

  // A page that names no layout renders with the runtime's built-in one when the foundation has no
  // default: it draws the header and the footer (`runtime/src/default-layout.js`).
  it('⭐ with no default layout, the built-in one draws the header and the footer', () => {
    const sides = { SideLayout: { name: 'SideLayout', areas: ['left', 'right'] } }
    expect(warningsOf(() => reportAreaNames({ Header: { area: 'header' }, Footer: { area: 'footer' } }, sides))).toEqual([])
    expect(warningsOf(() => reportAreaNames({ Header: { area: 'header' } }, sides, { defaultLayout: 'SideLayout' }))).toHaveLength(1)
  })

  it('⭐ a foundation with no layouts has the built-in one alone: a typo is warned', () => {
    const warned = warningsOf(() => reportAreaNames({ Header: { area: 'heder' }, Footer: { area: 'footer' } }, {}))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/Header \(meta\.js\): area names "heder".*\(they draw header, footer\)/)
  })

  it('nothing is said where no answer is known: a layout declaring no areas, an extension', () => {
    const types = { Nav: { area: 'right' } }
    expect(warningsOf(() => reportAreaNames(types, { ...layouts, Plain: { name: 'Plain' } }, asDefault))).toEqual([])
    expect(warningsOf(() => reportAreaNames(types, layouts, { isExtension: true }))).toEqual([])
  })
})
