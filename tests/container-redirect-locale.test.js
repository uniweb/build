/**
 * A content-less container's redirect stub, per locale.
 *
 * Prerender emits a `<meta http-equiv="refresh">` stub for a folder with no body
 * of its own, so the redirect works with JS disabled. That stub is written once
 * PER LOCALE — but its destination came from `page.getNavigableRoute()`, which
 * answers in CANONICAL routes, and was used raw.
 *
 * So `/fr/<container>` redirected to the DEFAULT-locale page: a reader who asked
 * for French, from a correct URL, silently got English. Measured on a bilingual
 * site — `/fr/Guide-de-démarrage-rapide` landed on
 * `/Quick-Start-Guide/From-Idea-to-Website`.
 *
 * ⚠️ This is a TWIN of the runtime's auto-redirect in PageRenderer.jsx, and the
 * comment above the prerender copy says so. The runtime copy carried the same
 * bug and was fixed first; fixing only one lane is worse than fixing neither,
 * because a container then behaves differently on a cold load (this stub) than
 * on an in-app navigation (the runtime). Change one, change both.
 *
 * The split that matters: the DECISION to redirect stays canonical, only the
 * DESTINATION is localized. Localizing before comparing would make a folder
 * whose navigable route is its own route redirect to itself forever.
 */
import { describe, it, expect } from 'vitest'
import { localizeRedirectTarget } from '../src/prerender.js'

// Minimal stand-in for the Website surface this helper touches.
const website = (basePath = '') => ({
  basePath,
  translateRoute(route, locale) {
    const map = {
      fr: {
        '/Quick-Start-Guide': '/Guide-de-démarrage-rapide',
        '/Quick-Start-Guide/From-Idea-to-Website': "/Guide-de-démarrage-rapide/De-l'idée-au-site-Web"
      }
    }
    return map[locale]?.[route] ?? route
  }
})

describe('localizeRedirectTarget', () => {
  it('translates the slug and re-applies the locale prefix', () => {
    expect(
      localizeRedirectTarget('/Quick-Start-Guide/From-Idea-to-Website', {
        website: website(),
        locale: 'fr',
        isDefault: false,
        routePrefix: '/fr'
      })
    ).toBe("/fr/Guide-de-démarrage-rapide/De-l'idée-au-site-Web")
  })

  it('leaves the default locale as a bare canonical route', () => {
    expect(
      localizeRedirectTarget('/Quick-Start-Guide/From-Idea-to-Website', {
        website: website(),
        locale: 'en',
        isDefault: true,
        routePrefix: ''
      })
    ).toBe('/Quick-Start-Guide/From-Idea-to-Website')
  })

  it('passes an untranslated route through, still prefixed', () => {
    // A slug spelled the same in both locales must still get the /fr prefix —
    // it is the prefix, not the translation, that keeps the reader in French.
    expect(
      localizeRedirectTarget('/Administration', {
        website: website(),
        locale: 'fr',
        isDefault: false,
        routePrefix: '/fr'
      })
    ).toBe('/fr/Administration')
  })

  it('honours a subdirectory deployment base', () => {
    expect(
      localizeRedirectTarget('/Quick-Start-Guide/From-Idea-to-Website', {
        website: website('/docs'),
        locale: 'fr',
        isDefault: false,
        routePrefix: '/fr'
      })
    ).toBe("/docs/fr/Guide-de-démarrage-rapide/De-l'idée-au-site-Web")
  })

  it('never emits a path missing its leading slash', () => {
    expect(
      localizeRedirectTarget('Quick-Start-Guide', {
        website: website(),
        locale: 'en',
        isDefault: true,
        routePrefix: ''
      })
    ).toBe('/Quick-Start-Guide')
  })
})
