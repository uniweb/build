import { collectSectionAssets } from '../src/site/assets.js'
import { rewriteContentPaths } from '../src/site/asset-processor.js'

describe('data block asset collection', () => {
  const siteRoot = '/fake/site'
  const markdownPath = '/fake/site/pages/about/1-hero.md'

  describe('collectSectionAssets', () => {
    it('collects assets from dataBlock', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'team-member',
                data: { name: 'Jane', avatar: './jane.jpg' }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['./jane.jpg']).toBeDefined()
      expect(assets['./jane.jpg'].original).toBe('./jane.jpg')
      expect(assets['./jane.jpg'].resolved).toBe('/fake/site/pages/about/jane.jpg')
      expect(assets['./jane.jpg'].isImage).toBe(true)
    })

    it('collects multiple assets from dataBlock', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'config',
                data: { logo: './logo.png', background: './hero.webp' }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['./logo.png']).toBeDefined()
      expect(assets['./logo.png'].isImage).toBe(true)
      expect(assets['./hero.webp']).toBeDefined()
    })

    it('collects nested array/object paths', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'gallery',
                data: {
                  title: 'Gallery',
                  images: [
                    { src: './photo1.jpg', caption: 'First' },
                    { src: './photo2.png', caption: 'Second' }
                  ],
                  meta: {
                    thumbnail: './thumb.webp'
                  }
                }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['./photo1.jpg']).toBeDefined()
      expect(assets['./photo2.png']).toBeDefined()
      expect(assets['./thumb.webp']).toBeDefined()
    })

    it('skips external URLs in data blocks', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'links',
                data: { logo: 'https://example.com/logo.png', local: './local.jpg' }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['https://example.com/logo.png']).toBeUndefined()
      expect(assets['./local.jpg']).toBeDefined()
    })

    it('skips non-media file extensions', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'files',
                data: { doc: './readme.txt', script: './app.js', image: './photo.jpg' }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['./readme.txt']).toBeUndefined()
      expect(assets['./app.js']).toBeUndefined()
      expect(assets['./photo.jpg']).toBeDefined()
    })

    it('skips untagged code blocks', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              attrs: { language: 'json' },
              content: [{ type: 'text', text: '{ "image": "./untagged.jpg" }' }]
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['./untagged.jpg']).toBeUndefined()
    })

    it('skips code blocks where parsing failed', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              attrs: { language: 'json', tag: 'no-data' },
              content: [{ type: 'text', text: '{ invalid json' }]
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(Object.keys(assets).length).toBe(0)
    })

    it('collects video and PDF files', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'media',
                data: { video: './intro.mp4', doc: './spec.pdf' }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['./intro.mp4']).toBeDefined()
      expect(assets['./intro.mp4'].isVideo).toBe(true)
      expect(assets['./spec.pdf']).toBeDefined()
      expect(assets['./spec.pdf'].isPdf).toBe(true)
    })

    it('handles parent directory paths', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'data',
                data: { image: '../shared/logo.png' }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['../shared/logo.png']).toBeDefined()
      expect(assets['../shared/logo.png'].resolved).toBe('/fake/site/pages/shared/logo.png')
    })

    it('handles absolute site paths', () => {
      const section = {
        content: {
          type: 'doc',
          content: [
            {
              type: 'dataBlock',
              attrs: {
                tag: 'data',
                data: { image: '/images/global.png' }
              }
            }
          ]
        }
      }

      const { assets } = collectSectionAssets(section, markdownPath, siteRoot)

      expect(assets['/images/global.png']).toBeDefined()
    })
  })

  describe('rewriteContentPaths for data blocks', () => {
    it('rewrites paths in dataBlock', () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'dataBlock',
            attrs: {
              tag: 'team',
              data: { avatar: './jane.jpg' }
            }
          }
        ]
      }

      const pathMapping = {
        './jane.jpg': '/assets/jane-abc123.webp'
      }

      const rewritten = rewriteContentPaths(content, pathMapping)

      expect(rewritten.content[0].attrs.data.avatar).toBe('/assets/jane-abc123.webp')
    })

    it('preserves non-path strings unchanged', () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'dataBlock',
            attrs: {
              tag: 'data',
              data: { name: 'Jane Doe', image: './photo.jpg', email: 'jane@example.com' }
            }
          }
        ]
      }

      const pathMapping = {
        './photo.jpg': '/assets/photo-xyz.webp'
      }

      const rewritten = rewriteContentPaths(content, pathMapping)

      expect(rewritten.content[0].attrs.data.name).toBe('Jane Doe')
      expect(rewritten.content[0].attrs.data.email).toBe('jane@example.com')
      expect(rewritten.content[0].attrs.data.image).toBe('/assets/photo-xyz.webp')
    })

    it('rewrites nested paths in arrays and objects', () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'dataBlock',
            attrs: {
              tag: 'gallery',
              data: {
                items: [
                  { src: './a.jpg' },
                  { src: './b.png' }
                ],
                meta: { thumb: './c.webp' }
              }
            }
          }
        ]
      }

      const pathMapping = {
        './a.jpg': '/assets/a-111.webp',
        './b.png': '/assets/b-222.webp',
        './c.webp': '/assets/c-333.webp'
      }

      const rewritten = rewriteContentPaths(content, pathMapping)

      expect(rewritten.content[0].attrs.data.items[0].src).toBe('/assets/a-111.webp')
      expect(rewritten.content[0].attrs.data.items[1].src).toBe('/assets/b-222.webp')
      expect(rewritten.content[0].attrs.data.meta.thumb).toBe('/assets/c-333.webp')
    })

    it('does not mutate original content', () => {
      const original = {
        type: 'doc',
        content: [
          {
            type: 'dataBlock',
            attrs: {
              tag: 'data',
              data: { image: './photo.jpg' }
            }
          }
        ]
      }

      const originalData = original.content[0].attrs.data.image

      rewriteContentPaths(original, { './photo.jpg': '/assets/photo.webp' })

      expect(original.content[0].attrs.data.image).toBe(originalData)
    })

    it('skips untagged code blocks', () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'json' },
            content: [{ type: 'text', text: '{ "image": "./photo.jpg" }' }]
          }
        ]
      }

      const pathMapping = { './photo.jpg': '/assets/photo.webp' }

      const rewritten = rewriteContentPaths(content, pathMapping)

      expect(rewritten.content[0].content[0].text).toBe('{ "image": "./photo.jpg" }')
    })

    it('skips code blocks where parsing failed', () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'json', tag: 'no-data' },
            content: [{ type: 'text', text: '{ "image": "./photo.jpg" }' }]
          }
        ]
      }

      const pathMapping = { './photo.jpg': '/assets/photo.webp' }

      expect(() => {
        rewriteContentPaths(content, pathMapping)
      }).not.toThrow()

      const rewritten = rewriteContentPaths(content, pathMapping)
      expect(rewritten.content[0].content[0].text).toBe('{ "image": "./photo.jpg" }')
    })
  })
})
