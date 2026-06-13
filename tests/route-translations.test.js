// Pins the localized-slug producer contract: per-page `slug:` maps in page.yml
// compile to `config.i18n.routeTranslations` — the map the @uniweb/core runtime
// (translateRoute / getLocaleUrl / getPageHierarchy) and the build sitemap
// already consume. Keyed by the canonical (default-locale) route string →
// per-locale display route. Default locale is omitted (its route is canonical);
// children without their own slug inherit a localized ancestor via the runtime's
// prefix-cascade, so they get no explicit entry here.

import { buildRouteTranslations } from '../src/site/content-collector.js'

describe('buildRouteTranslations', () => {
  it('returns null when nothing declares a slug', () => {
    expect(buildRouteTranslations([{ route: '/About-Us' }])).toBe(null)
    expect(buildRouteTranslations([])).toBe(null)
    expect(buildRouteTranslations(null)).toBe(null)
  })

  it('maps a localized slug keyed canonical → display, per non-default locale', () => {
    const pages = [{ route: '/About-Us', slug: { fr: 'a-propos', es: 'acerca-de' } }]
    const rt = buildRouteTranslations(pages, { defaultLocale: 'en', languages: ['en', 'fr', 'es'] })
    expect(rt).toEqual({
      fr: { '/About-Us': '/a-propos' },
      es: { '/About-Us': '/acerca-de' },
    })
  })

  it('skips a default-locale slug entry — the canonical route stays folder-based', () => {
    const pages = [{ route: '/About-Us', slug: { en: 'about', fr: 'a-propos' } }]
    const rt = buildRouteTranslations(pages, { defaultLocale: 'en', languages: ['en', 'fr'] })
    expect(rt).toEqual({ fr: { '/About-Us': '/a-propos' } })
    expect(rt.en).toBeUndefined()
  })

  it('composes nested localized segments when both ancestor and child are localized', () => {
    const pages = [
      { route: '/blog', slug: { fr: 'blogue' } },
      { route: '/blog/my-post', slug: { fr: 'mon-article' } },
    ]
    const rt = buildRouteTranslations(pages, { defaultLocale: 'en', languages: ['en', 'fr'] })
    expect(rt.fr['/blog']).toBe('/blogue')
    expect(rt.fr['/blog/my-post']).toBe('/blogue/mon-article')
  })

  it('localizes only the child segment when the ancestor declares no slug', () => {
    const pages = [
      { route: '/blog' }, // no slug
      { route: '/blog/my-post', slug: { fr: 'mon-article' } },
    ]
    const rt = buildRouteTranslations(pages, { defaultLocale: 'en', languages: ['en', 'fr'] })
    expect(rt.fr['/blog/my-post']).toBe('/blog/mon-article')
  })

  it('emits no explicit entry for a slug-less child (it inherits via prefix-cascade)', () => {
    const pages = [
      { route: '/blog', slug: { fr: 'blogue' } },
      { route: '/blog/plain' }, // no slug — runtime prefix-cascade handles it
    ]
    const rt = buildRouteTranslations(pages, { defaultLocale: 'en', languages: ['en', 'fr'] })
    expect(rt.fr).toEqual({ '/blog': '/blogue' })
    expect(rt.fr['/blog/plain']).toBeUndefined()
  })

  it('skips slug locales not declared in site languages', () => {
    const pages = [{ route: '/About-Us', slug: { fr: 'a-propos', de: 'ueber-uns' } }]
    const rt = buildRouteTranslations(pages, { defaultLocale: 'en', languages: ['en', 'fr'] })
    expect(rt).toEqual({ fr: { '/About-Us': '/a-propos' } })
    expect(rt.de).toBeUndefined()
  })

  it('skips invalid slug segments (slash / whitespace / empty)', () => {
    const pages = [{ route: '/About-Us', slug: { fr: 'a/propos', es: '', it: 'a propos' } }]
    const rt = buildRouteTranslations(pages, {
      defaultLocale: 'en',
      languages: ['en', 'fr', 'es', 'it'],
    })
    expect(rt).toBe(null)
  })

  it('applies no language filter when languages is null', () => {
    const pages = [{ route: '/About-Us', slug: { fr: 'a-propos' } }]
    const rt = buildRouteTranslations(pages, { defaultLocale: 'en', languages: null })
    expect(rt.fr['/About-Us']).toBe('/a-propos')
  })

  it('does not mutate the input pages', () => {
    const pages = [{ route: '/About-Us', slug: { fr: 'a-propos' } }]
    buildRouteTranslations(pages, { defaultLocale: 'en', languages: ['en', 'fr'] })
    expect(pages[0].slug).toEqual({ fr: 'a-propos' })
  })
})
