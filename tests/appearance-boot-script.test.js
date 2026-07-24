/**
 * The pre-paint appearance boot script inlined into prerendered pages.
 *
 * It exists so a prerendered page — which has real content in <body> styled
 * from :root light tokens — renders in the visitor's actual scheme from the
 * first paint, instead of flashing light before the bundle hydrates. Its logic
 * must stay a faithful inline mirror of resolveBootScheme() + applyScheme() in
 * @uniweb/runtime.
 */

import { describe, it, expect } from 'vitest'
import { renderAppearanceBootScript, injectBuildData } from '../src/prerender.js'

describe('renderAppearanceBootScript', () => {
  it('emits nothing when the site cannot reach dark', () => {
    expect(renderAppearanceBootScript(undefined)).toBe('')
    expect(renderAppearanceBootScript({ default: 'light', schemes: ['light'] })).toBe('')
    expect(renderAppearanceBootScript({ default: 'light', allowToggle: false })).toBe('')
  })

  it('emits a script for any dark-capable site', () => {
    expect(renderAppearanceBootScript({ allowToggle: true })).toContain('<script id="uniweb-appearance">')
    expect(renderAppearanceBootScript({ default: 'dark' })).toContain('scheme-dark')
    expect(renderAppearanceBootScript({ default: 'system' })).toContain('prefers-color-scheme')
  })

  it('reads the stored preference first', () => {
    const s = renderAppearanceBootScript({ allowToggle: true })
    expect(s).toContain("localStorage.getItem('uniweb-appearance')")
    // stored light/dark wins before the system/default branch
    expect(s).toContain("(s==='light'||s==='dark')?s:")
  })

  it('bakes respectSystemPreference as a literal boolean', () => {
    expect(renderAppearanceBootScript({ allowToggle: true, respectSystemPreference: true })).toContain(
      '(true&&matchMedia'
    )
    expect(renderAppearanceBootScript({ allowToggle: true, respectSystemPreference: false })).toContain(
      '(false&&matchMedia'
    )
  })

  it('defaults respectSystemPreference to true (opt out, not opt in)', () => {
    // Matches normalizeAppearance / resolveBootScheme: absent means true.
    expect(renderAppearanceBootScript({ allowToggle: true })).toContain('(true&&matchMedia')
  })

  it('bakes only the coerced default scheme, never a raw author string', () => {
    // A dark default falls through to 'dark'; anything else to 'light'. No
    // author-supplied value reaches the script body, so it cannot inject.
    expect(renderAppearanceBootScript({ default: 'dark' })).toContain(":'dark'")
    expect(renderAppearanceBootScript({ default: 'system' })).toContain(":'light'")
    const injected = renderAppearanceBootScript({ allowToggle: true, default: "light';alert(1)//" })
    expect(injected).not.toContain('alert(1)')
    expect(injected).toContain(":'light'")
  })

  it('sets an explicit class in both branches', () => {
    const s = renderAppearanceBootScript({ default: 'system' })
    expect(s).toContain("d.classList.add('scheme-dark')")
    expect(s).toContain("d.classList.add('scheme-light')")
  })
})

describe('injectBuildData — appearance boot script', () => {
  const html = '<html><head></head><body>content</body></html>'

  it('injects the script into <head> for a dark-capable site', () => {
    const out = injectBuildData(html, { theme: { appearance: { allowToggle: true } } })
    expect(out).toContain('id="uniweb-appearance"')
    expect(out.indexOf('id="uniweb-appearance"')).toBeLessThan(out.indexOf('</head>'))
  })

  it('injects nothing for a light-only site', () => {
    const out = injectBuildData(html, { theme: { appearance: { default: 'light', schemes: ['light'] } } })
    expect(out).not.toContain('id="uniweb-appearance"')
  })

  it('does not double-inject', () => {
    const once = injectBuildData(html, { theme: { appearance: { allowToggle: true } } })
    const twice = injectBuildData(once, { theme: { appearance: { allowToggle: true } } })
    expect(twice.match(/id="uniweb-appearance"/g)).toHaveLength(1)
  })
})
