/**
 * A component param named after one of a section's own settings — `theme`, `background`,
 * `grid`, `vars` (`@uniweb/schemas/section`) — never receives what an author writes: framework
 * applies those, and a component reads them from its block [Diego, 2026-09-28]. The build warns.
 */

import { reportPlacementDeclarations } from '../src/schema.js'

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
    for (const name of ['theme', 'background', 'vars', 'grid']) expect(text).toMatch(new RegExp(`param named "${name}"`))
    expect(text).not.toMatch(/param named "layout"/)
  })

  it('says nothing about a component whose params are its own', () => {
    reportPlacementDeclarations({ Hero: { name: 'Hero', params: { layout: {}, variant: {} } } })
    expect(warnings).toEqual([])
  })
})
