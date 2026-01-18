import { extractTranslatableContent } from '../../src/i18n/extract.js'
import { computeHash } from '../../src/i18n/hash.js'

describe('extractTranslatableContent', () => {
  it('returns manifest with version and metadata', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: []
    }
    const manifest = extractTranslatableContent(siteContent)

    expect(manifest.version).toBe('1.0')
    expect(manifest.defaultLocale).toBe('en')
    expect(manifest.extracted).toBeDefined()
    expect(manifest.units).toBeDefined()
  })

  it('extracts page title from page metadata', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/',
        title: 'Home Page',
        sections: []
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const hash = computeHash('Home Page')
    expect(manifest.units[hash]).toBeDefined()
    expect(manifest.units[hash].source).toBe('Home Page')
    expect(manifest.units[hash].field).toBe('page.title')
    expect(manifest.units[hash].contexts).toEqual([{ page: '/', section: '_meta' }])
  })

  it('extracts page description from page metadata', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/about',
        title: 'About',
        description: 'Learn more about us',
        sections: []
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const hash = computeHash('Learn more about us')
    expect(manifest.units[hash]).toBeDefined()
    expect(manifest.units[hash].source).toBe('Learn more about us')
    expect(manifest.units[hash].field).toBe('page.description')
  })

  it('extracts SEO fields from page metadata', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
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
    const manifest = extractTranslatableContent(siteContent)

    const ogTitleHash = computeHash('Welcome to Our Site')
    const ogDescHash = computeHash('The best site ever')

    expect(manifest.units[ogTitleHash]).toBeDefined()
    expect(manifest.units[ogTitleHash].field).toBe('page.seo.ogTitle')
    expect(manifest.units[ogDescHash]).toBeDefined()
    expect(manifest.units[ogDescHash].field).toBe('page.seo.ogDescription')
  })

  it('extracts keywords as separate units', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/',
        title: 'Home',
        keywords: ['web', 'development', 'react'],
        sections: []
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const webHash = computeHash('web')
    const devHash = computeHash('development')
    const reactHash = computeHash('react')

    expect(manifest.units[webHash]).toBeDefined()
    expect(manifest.units[webHash].field).toBe('page.keyword.0')
    expect(manifest.units[devHash]).toBeDefined()
    expect(manifest.units[devHash].field).toBe('page.keyword.1')
    expect(manifest.units[reactHash]).toBeDefined()
    expect(manifest.units[reactHash].field).toBe('page.keyword.2')
  })

  it('extracts headings from section content', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: 'Welcome' }]
              }
            ]
          }
        }]
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const hash = computeHash('Welcome')
    expect(manifest.units[hash]).toBeDefined()
    expect(manifest.units[hash].source).toBe('Welcome')
    expect(manifest.units[hash].field).toBe('title')
    expect(manifest.units[hash].contexts).toEqual([{ page: '/', section: 'hero' }])
  })

  it('extracts paragraphs from section content', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'hero',
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Hello world' }]
              }
            ]
          }
        }]
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const hash = computeHash('Hello world')
    expect(manifest.units[hash]).toBeDefined()
    expect(manifest.units[hash].source).toBe('Hello world')
    expect(manifest.units[hash].field).toBe('paragraph')
  })

  it('extracts link labels from content', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'cta',
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{
                  type: 'text',
                  text: 'Learn more',
                  marks: [{ type: 'link', attrs: { href: '/about' } }]
                }]
              }
            ]
          }
        }]
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const hash = computeHash('Learn more')
    expect(manifest.units[hash]).toBeDefined()
    expect(manifest.units[hash].field).toBe('link.label')
  })

  it('handles nested subsections', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
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
              content: [
                {
                  type: 'heading',
                  attrs: { level: 2 },
                  content: [{ type: 'text', text: 'Fast' }]
                }
              ]
            }
          }]
        }]
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const hash = computeHash('Fast')
    expect(manifest.units[hash]).toBeDefined()
    expect(manifest.units[hash].contexts).toEqual([{ page: '/', section: 'feature-1' }])
  })

  it('handles same text appearing in multiple contexts', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/',
        title: 'Home',
        sections: [
          {
            id: 'hero',
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Learn more' }]
                }
              ]
            }
          },
          {
            id: 'cta',
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Learn more' }]
                }
              ]
            }
          }
        ]
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const hash = computeHash('Learn more')
    expect(manifest.units[hash]).toBeDefined()
    expect(manifest.units[hash].contexts).toHaveLength(2)
    expect(manifest.units[hash].contexts).toContainEqual({ page: '/', section: 'hero' })
    expect(manifest.units[hash].contexts).toContainEqual({ page: '/', section: 'cta' })
  })

  it('extracts list items', () => {
    const siteContent = {
      config: { defaultLanguage: 'en' },
      pages: [{
        route: '/',
        title: 'Home',
        sections: [{
          id: 'features',
          content: {
            type: 'doc',
            content: [
              {
                type: 'bulletList',
                content: [
                  {
                    type: 'listItem',
                    content: [{
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'First item' }]
                    }]
                  },
                  {
                    type: 'listItem',
                    content: [{
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Second item' }]
                    }]
                  }
                ]
              }
            ]
          }
        }]
      }]
    }
    const manifest = extractTranslatableContent(siteContent)

    const firstHash = computeHash('First item')
    const secondHash = computeHash('Second item')

    expect(manifest.units[firstHash]).toBeDefined()
    expect(manifest.units[firstHash].field).toBe('list.0')
    expect(manifest.units[secondHash]).toBeDefined()
    expect(manifest.units[secondHash].field).toBe('list.1')
  })
})
