import { mergeTranslations, generateAllLocales } from '../../src/i18n/merge.js'
import { computeHash } from '../../src/i18n/hash.js'

describe('mergeTranslations', () => {
  it('applies simple string translations', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [{
              type: 'heading',
              attrs: { level: 1 },
              content: [{ type: 'text', text: 'Welcome' }]
            }]
          }
        }]
      }]
    }
    const translations = {
      [computeHash('Welcome')]: 'Bienvenido'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].sections[0].content.content[0].content[0].text).toBe('Bienvenido')
  })

  it('does not mutate original content', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Hello' }]
            }]
          }
        }]
      }]
    }
    const translations = {
      [computeHash('Hello')]: 'Hola'
    }

    mergeTranslations(siteContent, translations)

    expect(siteContent.pages[0].sections[0].content.content[0].content[0].text).toBe('Hello')
  })

  it('falls back to source when no translation exists', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Untranslated text' }]
            }]
          }
        }]
      }]
    }
    const translations = {}

    const translated = mergeTranslations(siteContent, translations, { fallbackToSource: true })

    expect(translated.pages[0].sections[0].content.content[0].content[0].text).toBe('Untranslated text')
  })

  it('translates page metadata (title)', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home Page',
        sections: []
      }]
    }
    const translations = {
      [computeHash('Home Page')]: 'Página de Inicio'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].title).toBe('Página de Inicio')
  })

  it('translates page metadata (description)', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        description: 'Welcome to our site',
        sections: []
      }]
    }
    const translations = {
      [computeHash('Welcome to our site')]: 'Bienvenido a nuestro sitio'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].description).toBe('Bienvenido a nuestro sitio')
  })

  it('translates SEO fields', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        seo: {
          ogTitle: 'Welcome to Our Site',
          ogDescription: 'The best site ever'
        },
        sections: []
      }]
    }
    const translations = {
      [computeHash('Welcome to Our Site')]: 'Bienvenido a Nuestro Sitio',
      [computeHash('The best site ever')]: 'El mejor sitio'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].seo.ogTitle).toBe('Bienvenido a Nuestro Sitio')
    expect(translated.pages[0].seo.ogDescription).toBe('El mejor sitio')
  })

  it('translates keywords array', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        keywords: ['web', 'development'],
        sections: []
      }]
    }
    const translations = {
      [computeHash('web')]: 'red',
      [computeHash('development')]: 'desarrollo'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].keywords).toEqual(['red', 'desarrollo'])
  })

  it('applies context-specific overrides', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Click here' }]
            }]
          }
        }, {
          id: 'cta',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Click here' }]
            }]
          }
        }]
      }]
    }
    const translations = {
      [computeHash('Click here')]: {
        default: 'Haga clic aquí',
        overrides: {
          '/:cta': 'Haga clic aquí para empezar'
        }
      }
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].sections[0].content.content[0].content[0].text).toBe('Haga clic aquí')
    expect(translated.pages[0].sections[1].content.content[0].content[0].text).toBe('Haga clic aquí para empezar')
  })

  it('preserves structure of untranslated content', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [{
              type: 'heading',
              attrs: { level: 1 },
              content: [{ type: 'text', text: 'Welcome' }]
            }, {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Untranslated' }]
            }]
          }
        }]
      }]
    }
    const translations = {
      [computeHash('Welcome')]: 'Bienvenido'
    }

    const translated = mergeTranslations(siteContent, translations)

    // Structure preserved
    expect(translated.pages[0].sections[0].content.content).toHaveLength(2)
    expect(translated.pages[0].sections[0].content.content[0].type).toBe('heading')
    expect(translated.pages[0].sections[0].content.content[1].type).toBe('paragraph')
    // Heading translated
    expect(translated.pages[0].sections[0].content.content[0].content[0].text).toBe('Bienvenido')
    // Paragraph unchanged
    expect(translated.pages[0].sections[0].content.content[1].content[0].text).toBe('Untranslated')
  })

  it('translates nested subsections', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'features',
          content: { type: 'doc', content: [] },
          subsections: [{
            id: 'feature-1',
            content: {
              type: 'doc',
              content: [{
                type: 'heading',
                attrs: { level: 2 },
                content: [{ type: 'text', text: 'Fast' }]
              }]
            }
          }]
        }]
      }]
    }
    const translations = {
      [computeHash('Fast')]: 'Rápido'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].sections[0].subsections[0].content.content[0].content[0].text).toBe('Rápido')
  })

  it('translates header section content', () => {
    const siteContent = {
      pages: [],
      header: {
        route: '/layout/header',
        sections: [{
          id: '1',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'My Brand' }]
            }]
          }
        }]
      }
    }
    const translations = {
      [computeHash('My Brand')]: 'Mi Marca'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.header.sections[0].content.content[0].content[0].text).toBe('Mi Marca')
  })

  it('translates footer section content', () => {
    const siteContent = {
      pages: [],
      footer: {
        route: '/layout/footer',
        sections: [{
          id: '1',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Copyright notice' }]
            }]
          }
        }]
      }
    }
    const translations = {
      [computeHash('Copyright notice')]: 'Aviso de derechos'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.footer.sections[0].content.content[0].content[0].text).toBe('Aviso de derechos')
  })

  it('translates left and right sidebar sections', () => {
    const siteContent = {
      pages: [],
      left: {
        route: '/layout/left',
        sections: [{
          id: '1',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Navigation' }]
            }]
          }
        }]
      },
      right: {
        route: '/layout/right',
        sections: [{
          id: '1',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Sidebar' }]
            }]
          }
        }]
      }
    }
    const translations = {
      [computeHash('Navigation')]: 'Navegación',
      [computeHash('Sidebar')]: 'Barra lateral'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.left.sections[0].content.content[0].content[0].text).toBe('Navegación')
    expect(translated.right.sections[0].content.content[0].content[0].text).toBe('Barra lateral')
  })

  it('skips layout sections that do not exist', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: []
      }]
    }
    const translations = {}

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.header).toBeUndefined()
    expect(translated.footer).toBeUndefined()
    expect(translated.left).toBeUndefined()
    expect(translated.right).toBeUndefined()
  })

  it('preserves leading/trailing whitespace from original', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: '  Hello  ' }]
            }]
          }
        }]
      }]
    }
    const translations = {
      [computeHash('Hello')]: 'Hola'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.pages[0].sections[0].content.content[0].content[0].text).toBe('  Hola  ')
  })
})

describe('generateAllLocales', () => {
  it('generates translated content for multiple locales', () => {
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [{
              type: 'heading',
              attrs: { level: 1 },
              content: [{ type: 'text', text: 'Welcome' }]
            }]
          }
        }]
      }]
    }
    const localeFiles = {
      es: {
        [computeHash('Home')]: 'Inicio',
        [computeHash('Welcome')]: 'Bienvenido'
      },
      fr: {
        [computeHash('Home')]: 'Accueil',
        [computeHash('Welcome')]: 'Bienvenue'
      }
    }

    const results = generateAllLocales(siteContent, localeFiles)

    expect(results.es.pages[0].title).toBe('Inicio')
    expect(results.es.pages[0].sections[0].content.content[0].content[0].text).toBe('Bienvenido')
    expect(results.fr.pages[0].title).toBe('Accueil')
    expect(results.fr.pages[0].sections[0].content.content[0].content[0].text).toBe('Bienvenue')
  })
})
