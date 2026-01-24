// Using Jest (built-in globals, no imports needed)
import { processCollections, writeCollectionFiles } from '../src/site/collection-processor.js'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Collection Processor', () => {
  let testDir

  beforeEach(() => {
    // Create a temporary test directory
    testDir = join(tmpdir(), `collection-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('processCollections', () => {
    it('should process markdown files into collection items', async () => {
      // Create test library folder
      const contentDir = join(testDir, 'library', 'articles')
      mkdirSync(contentDir, { recursive: true })

      // Create test markdown file
      writeFileSync(join(contentDir, 'test-article.md'), `---
title: Test Article
date: 2025-01-15
author: Test Author
tags: [test, example]
---

## Introduction

This is a test article.
`)

      const collections = await processCollections(testDir, {
        articles: {
          path: 'library/articles',
          sort: 'date desc'
        }
      })

      expect(collections.articles).toBeDefined()
      expect(collections.articles).toHaveLength(1)

      const article = collections.articles[0]
      expect(article.slug).toBe('test-article')
      expect(article.title).toBe('Test Article')
      // js-yaml parses dates into Date objects, so check for either format
      const expectedDate = new Date('2025-01-15T00:00:00.000Z')
      expect(new Date(article.date).getTime()).toBe(expectedDate.getTime())
      expect(article.author).toBe('Test Author')
      expect(article.tags).toEqual(['test', 'example'])
      expect(article.body).toContain('## Introduction')
      expect(article.content).toBeDefined()
      expect(article.excerpt).toBeDefined()
    })

    it('should exclude unpublished items', async () => {
      const contentDir = join(testDir, 'library', 'articles')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'published.md'), `---
title: Published Article
---

Content here.
`)

      writeFileSync(join(contentDir, 'draft.md'), `---
title: Draft Article
published: false
---

Draft content.
`)

      const collections = await processCollections(testDir, {
        articles: 'library/articles'
      })

      expect(collections.articles).toHaveLength(1)
      expect(collections.articles[0].title).toBe('Published Article')
    })

    it('should apply filter expressions', async () => {
      const contentDir = join(testDir, 'library', 'posts')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'post1.md'), `---
title: Post 1
category: tutorial
---
Content.
`)

      writeFileSync(join(contentDir, 'post2.md'), `---
title: Post 2
category: news
---
Content.
`)

      const collections = await processCollections(testDir, {
        posts: {
          path: 'library/posts',
          filter: 'category == tutorial'
        }
      })

      expect(collections.posts).toHaveLength(1)
      expect(collections.posts[0].title).toBe('Post 1')
    })

    it('should sort items by field', async () => {
      const contentDir = join(testDir, 'library', 'items')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'a.md'), `---
title: A
order: 3
---
`)

      writeFileSync(join(contentDir, 'b.md'), `---
title: B
order: 1
---
`)

      writeFileSync(join(contentDir, 'c.md'), `---
title: C
order: 2
---
`)

      const collections = await processCollections(testDir, {
        items: {
          path: 'library/items',
          sort: 'order asc'
        }
      })

      expect(collections.items.map(i => i.title)).toEqual(['B', 'C', 'A'])
    })

    it('should limit number of items', async () => {
      const contentDir = join(testDir, 'library', 'posts')
      mkdirSync(contentDir, { recursive: true })

      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(contentDir, `post${i}.md`), `---
title: Post ${i}
order: ${i}
---
`)
      }

      const collections = await processCollections(testDir, {
        posts: {
          path: 'library/posts',
          sort: 'order asc',
          limit: 3
        }
      })

      expect(collections.posts).toHaveLength(3)
    })

    it('should handle missing collection folder gracefully', async () => {
      const collections = await processCollections(testDir, {
        articles: 'library/nonexistent'
      })

      expect(collections.articles).toEqual([])
    })

    it('should return empty object for no collections config', async () => {
      const collections = await processCollections(testDir, null)
      expect(collections).toEqual({})
    })

    it('should add route to items when collection has route config', async () => {
      const contentDir = join(testDir, 'library', 'articles')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'my-article.md'), `---
title: My Article
---

Content here.
`)

      const collections = await processCollections(testDir, {
        articles: {
          path: 'library/articles',
          route: '/blog'
        }
      })

      expect(collections.articles).toHaveLength(1)
      expect(collections.articles[0].route).toBe('/blog/my-article')
    })

    it('should handle trailing slash in route config', async () => {
      const contentDir = join(testDir, 'library', 'posts')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'test-post.md'), `---
title: Test Post
---

Content.
`)

      const collections = await processCollections(testDir, {
        posts: {
          path: 'library/posts',
          route: '/news/'
        }
      })

      expect(collections.posts[0].route).toBe('/news/test-post')
    })

    it('should not add route when route config is absent', async () => {
      const contentDir = join(testDir, 'library', 'items')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'item.md'), `---
title: Item
---

Content.
`)

      const collections = await processCollections(testDir, {
        items: 'library/items'
      })

      expect(collections.items[0].route).toBeUndefined()
    })
  })

  describe('writeCollectionFiles', () => {
    it('should write JSON files to public/data/', async () => {
      const collections = {
        articles: [
          { slug: 'test', title: 'Test Article' }
        ]
      }

      await writeCollectionFiles(testDir, collections)

      const outputPath = join(testDir, 'public', 'data', 'articles.json')
      expect(existsSync(outputPath)).toBe(true)

      const content = JSON.parse(readFileSync(outputPath, 'utf-8'))
      expect(content).toHaveLength(1)
      expect(content[0].slug).toBe('test')
    })

    it('should handle empty collections', async () => {
      await writeCollectionFiles(testDir, {})
      // Should not throw
    })
  })

  describe('excerpt extraction', () => {
    it('should auto-extract excerpt from content', async () => {
      const contentDir = join(testDir, 'library', 'posts')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'post.md'), `---
title: Post
---

This is the first paragraph of the article that should become the excerpt.

This is the second paragraph.
`)

      const collections = await processCollections(testDir, {
        posts: 'library/posts'
      })

      expect(collections.posts[0].excerpt).toContain('first paragraph')
    })

    it('should prefer explicit excerpt from frontmatter', async () => {
      const contentDir = join(testDir, 'library', 'posts')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'post.md'), `---
title: Post
excerpt: Custom excerpt here
---

This is the body content.
`)

      const collections = await processCollections(testDir, {
        posts: 'library/posts'
      })

      expect(collections.posts[0].excerpt).toBe('Custom excerpt here')
    })
  })
})
