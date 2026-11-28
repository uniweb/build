/**
 * A foundation's named backgrounds (`main.js` `backgrounds:`): the page gets each value without
 * its label, description and preview, which only an editor reads, and the editor's schema keeps
 * them whole in `_self` [2026-11-28].
 */
import { describe, it, expect } from 'vitest'
import { extractFoundationRuntime } from '../src/runtime-schema.js'

describe('a foundation\'s named backgrounds, as a page draws them', () => {
  it('each value without what only an editor shows', () => {
    const { data } = extractFoundationRuntime({
      name: '@acme/marketing',
      backgrounds: {
        dots: { label: 'Dot grid', description: 'A quiet grid', preview: '/p.png', color: 'card', theme: 'medium' },
        photo: '/images/hero.jpg',
      },
    })
    expect(data.backgrounds).toEqual({ dots: { color: 'card', theme: 'medium' }, photo: '/images/hero.jpg' })
  })

  it('a foundation with none carries none', () => {
    expect(extractFoundationRuntime({ name: '@acme/marketing' }).data).not.toHaveProperty('backgrounds')
  })
})
