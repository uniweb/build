/**
 * robots.txt — the `Content-Signal:` directive.
 *
 * Content Signals sit on a different axis from `Disallow:`. That governs
 * *fetching*; this governs *use after fetching* — search results, inference-time
 * retrieval, model training. So the two never substitute for each other, and a
 * site can allow crawling while declining training.
 *
 * The load-bearing case is the absent one: an undeclared signal must emit
 * nothing. Emitting a default in either direction would assert a preference the
 * site owner never stated, and "unstated" is not "no".
 */

import { formatContentSignals, generateRobotsTxt } from '../src/site/plugin.js'

describe('formatContentSignals', () => {
  test('emits nothing when undeclared — silence is not consent, nor refusal', () => {
    expect(formatContentSignals(null)).toBe('')
    expect(formatContentSignals(undefined)).toBe('')
    expect(formatContentSignals({})).toBe('')
  })

  test('booleans become yes/no', () => {
    expect(formatContentSignals({ search: true, 'ai-input': true, 'ai-train': false })).toBe(
      'Content-Signal: search=yes, ai-input=yes, ai-train=no'
    )
  })

  test('the string forms are accepted too, since YAML invites them', () => {
    expect(formatContentSignals({ search: 'yes', 'ai-train': 'no' })).toBe(
      'Content-Signal: search=yes, ai-train=no'
    )
  })

  test('order is canonical, not authoring order — the output must be deterministic', () => {
    const a = formatContentSignals({ 'ai-train': false, search: true, 'ai-input': true })
    const b = formatContentSignals({ search: true, 'ai-input': true, 'ai-train': false })
    expect(a).toBe(b)
    expect(a).toBe('Content-Signal: search=yes, ai-input=yes, ai-train=no')
  })

  test('a partial declaration emits only what was declared', () => {
    expect(formatContentSignals({ 'ai-train': false })).toBe('Content-Signal: ai-train=no')
  })

  test('unknown keys are dropped, not forwarded', () => {
    // The vocabulary is a closed set. Forwarding an invented signal would
    // produce a directive no crawler honors while reading as though it did.
    expect(formatContentSignals({ 'ai-summarize': true })).toBe('')
    expect(formatContentSignals({ search: true, 'ai-summarize': true })).toBe(
      'Content-Signal: search=yes'
    )
  })

  test('a non-boolean value is skipped rather than coerced', () => {
    // `search: maybe` is an authoring mistake; guessing at it would encode the
    // guess into a published policy file.
    expect(formatContentSignals({ search: 'maybe', 'ai-train': false })).toBe(
      'Content-Signal: ai-train=no'
    )
  })
})

describe('generateRobotsTxt — placement', () => {
  test('the directive sits inside the User-agent group, above the rules', () => {
    const out = generateRobotsTxt('https://example.com', {
      contentSignals: { search: true, 'ai-train': false },
      disallow: ['/internal'],
    })

    const lines = out.split('\n')
    expect(lines[0]).toBe('User-agent: *')
    expect(lines[1]).toBe('Content-Signal: search=yes, ai-train=no')
    expect(lines[2]).toBe('Disallow: /internal')
  })

  test('an undeclared block leaves robots.txt byte-identical to before', () => {
    const withOut = generateRobotsTxt('https://example.com', { disallow: ['/internal'] })
    const withNull = generateRobotsTxt('https://example.com', {
      disallow: ['/internal'],
      contentSignals: null,
    })
    expect(withNull).toBe(withOut)
    expect(withOut).toBe('User-agent: *\nDisallow: /internal\n\nSitemap: https://example.com/sitemap.xml\n')
  })

  test('signals coexist with allow, crawl-delay and sitemaps', () => {
    const out = generateRobotsTxt('https://example.com', {
      contentSignals: { 'ai-input': true },
      allow: ['/public'],
      crawlDelay: 2,
      additionalSitemaps: ['https://example.com/news-sitemap.xml'],
    })

    expect(out).toContain('Content-Signal: ai-input=yes')
    expect(out).toContain('Allow: /public')
    expect(out).toContain('Crawl-delay: 2')
    expect(out).toContain('Sitemap: https://example.com/news-sitemap.xml')
  })
})
