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
      layouts: {
        default: {
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
      }
    }
    const translations = {
      [computeHash('My Brand')]: 'Mi Marca'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.layouts.default.header.sections[0].content.content[0].content[0].text).toBe('Mi Marca')
  })

  it('translates footer section content', () => {
    const siteContent = {
      pages: [],
      layouts: {
        default: {
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
      }
    }
    const translations = {
      [computeHash('Copyright notice')]: 'Aviso de derechos'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.layouts.default.footer.sections[0].content.content[0].content[0].text).toBe('Aviso de derechos')
  })

  it('translates left and right sidebar sections', () => {
    const siteContent = {
      pages: [],
      layouts: {
        default: {
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
      }
    }
    const translations = {
      [computeHash('Navigation')]: 'Navegación',
      [computeHash('Sidebar')]: 'Barra lateral'
    }

    const translated = mergeTranslations(siteContent, translations)

    expect(translated.layouts.default.left.sections[0].content.content[0].content[0].text).toBe('Navegación')
    expect(translated.layouts.default.right.sections[0].content.content[0].content[0].text).toBe('Barra lateral')
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

  it('whole-element resolution keys by trimmed text (block padding not re-added)', () => {
    // Under whole-element substitution a block element is keyed by its TRIMMED
    // text and its inline content is replaced by the translation. Insignificant
    // leading/trailing block whitespace is not re-applied — that was a
    // per-text-node artifact of the old substitution model.
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

    expect(translated.pages[0].sections[0].content.content[0].content[0].text).toBe('Hola')
  })

  it('resolves a mark-carrying translation value (whole-element, inline markdown)', () => {
    // The key win over the old plain-string value: a target locale can carry an
    // inline link (with its own, re-targeted href) and emphasis. Source is one
    // paragraph "See our docs now." with an inline link on "our docs"; the
    // translation VALUE is inline markdown.
    const siteContent = {
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'cta',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [
                { type: 'text', text: 'See ' },
                { type: 'text', text: 'our docs', marks: [{ type: 'link', attrs: { href: '/docs' } }] },
                { type: 'text', text: ' now.' }
              ]
            }]
          }
        }]
      }]
    }
    const translations = {
      [computeHash('See our docs now.')]: 'Voir [nos docs](/fr/docs) maintenant.'
    }

    const translated = mergeTranslations(siteContent, translations)
    const para = translated.pages[0].sections[0].content.content[0]

    // Full text reads as the translation
    expect(para.content.map(n => n.text || '').join('')).toBe('Voir nos docs maintenant.')
    // The inline link survived with its (re-targeted) href — impossible with the
    // old plain-string value
    const linkNode = para.content.find(n => n.marks?.some(m => m.type === 'link'))
    expect(linkNode).toBeDefined()
    expect(linkNode.text).toBe('nos docs')
    expect(linkNode.marks.find(m => m.type === 'link').attrs.href).toBe('/fr/docs')
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
