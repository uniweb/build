import { describe, it, expect } from 'vitest'
import { overlayProblems } from '../src/site/background-check.js'

// The runtime draws an overlay only with `enabled: true` and reads only its own keys
// (`runtime/src/background.js`), so a build says what it would drop.
describe('overlayProblems', () => {
  it('passes the forms the runtime draws', () => {
    expect(overlayProblems({ image: '/a.jpg', overlay: 0.5 })).toEqual([])
    expect(overlayProblems({ overlay: { enabled: true, type: 'dark', opacity: 0.5 } })).toEqual([])
    expect(
      overlayProblems({ overlay: { enabled: true, opacity: 1, gradient: { angle: 90, start: 'rgba(0,0,0,0.8)', startPosition: 0, end: 'rgba(0,0,0,0)', endPosition: 60 } } })
    ).toEqual([])
    expect(overlayProblems({ image: '/a.jpg' })).toEqual([])
    expect(overlayProblems('/a.jpg')).toEqual([])
  })

  it('names what an overlay written from memory holds that draws nothing', () => {
    const problems = overlayProblems({ overlay: { type: 'gradient', gradient: 'linear-gradient(#000, #0000)' } })
    expect(problems.join('\n')).toMatch(/type: "gradient" is not `dark` or `light`/)
    expect(problems.join('\n')).toMatch(/gradient is "linear-gradient/)
    expect(problems.join('\n')).toMatch(/drawn only with `enabled: true`/)
  })

  it('names keys it does not read', () => {
    expect(overlayProblems({ overlay: { enabled: true, color: '#000' } })).toEqual([
      'background.overlay: `color` is not read — an overlay takes `enabled`, `type`, `opacity`, `gradient`.',
    ])
    expect(overlayProblems({ overlay: { enabled: true, gradient: { from: '#000' } } })[0]).toMatch(/`from` is not read/)
  })

  it('names an overlay that is neither a number nor its fields', () => {
    expect(overlayProblems({ overlay: 'linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6))' })[0]).toMatch(/is not an overlay/)
  })
})
