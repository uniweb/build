/**
 * A component param named after one of a section's own settings — `theme`, `background`,
 * `grid`, `vars` (`@uniweb/schemas/section`) — never receives what an author writes: framework
 * applies those, and a component reads them from its block [Diego, 2026-09-28]. The build warns.
 */

import { reportPlacementDeclarations } from '../src/schema.js'
import { SECTION_KEYS } from '@uniweb/schemas/section'

let warnings
beforeEach(() => {
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)))
})
afterEach(() => vi.restoreAllMocks())

describe('a component param named after a section setting', () => {
  it('warns, for each of the four', () => {
    reportPlacementDeclarations({
      Hero: { name: 'Hero', params: { theme: { type: 'select' }, background: {}, vars: {}, grid: {}, layout: {} } },
    })
    const text = warnings.join('\n')
    for (const name of ['theme', 'background', 'vars', 'grid']) expect(text).toMatch(new RegExp(`params declares "${name}", a setting of the section`))
    expect(text).not.toMatch(/params declares "layout"/)
  })

  it('and for a key a section keeps for itself — every one of SECTION_KEYS', () => {
    const names = Object.keys(SECTION_KEYS)
    reportPlacementDeclarations({ Hero: { name: 'Hero', params: Object.fromEntries([...names, 'layout'].map((n) => [n, {}])) } })
    const text = warnings.join('\n')
    for (const name of names) expect(text).toMatch(new RegExp(`params declares "${name}", a key a section's frontmatter keeps for itself`))
    expect(text).not.toMatch(/params declares "layout"/)
  })

  it('says nothing about a component whose params are its own', () => {
    reportPlacementDeclarations({ Hero: { name: 'Hero', params: { layout: {}, variant: {} } } })
    expect(warnings).toEqual([])
  })
})
