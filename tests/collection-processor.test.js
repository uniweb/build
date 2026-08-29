// Using Jest (built-in globals, no imports needed)
import { processCollections, writeCollectionFiles } from '../src/site/collection-processor.js'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// Derived, never re-spelled — the convention is pinned once, in
// `@uniweb/core`'s tests/data-paths.test.js.
import { DATA_DIR } from '@uniweb/core'

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

  // ⛔ THE 'NESTED RECORDS' BLOCK WAS DELETED, NOT MIGRATED. It exercised
  // recursion into subdirectories of a collection — a capability
  // `entities/{schema}/` deliberately does not have, because that path declares
  // a model and nothing else. Placement moved to `records.yml`, and the pool
  // reader refuses nesting outright (`entity-pool.test.js`).
  //
  // ⭐ Deleting it CLOSED a divergence rather than losing coverage: the sync lane
  // never followed that recursion, so a nested record built and rendered locally
  // while being silently absent from every push — which the sync-lane reader
  // itself warned about. One flat pool, both lanes.
  //
  // What survives is the slug-collision report, which the pool can still reach
  // via two extensions of one stem.
  describe('slug collisions inside a schema folder', () => {
    const writeRecord = (dir, name, title) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), `---\ntitle: ${title}\n---\n\nBody.\n`)
    }

    it('warns when two files in one schema folder share a slug', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const root = join(testDir, 'entities', 'note')
      writeRecord(root, 'notes.md', 'From markdown')
      writeFileSync(join(root, 'notes.yml'), 'title: From yaml\n')
      await processCollections(testDir, { notes: { name: 'notes', schema: '@/note' } }, undefined, '/')
      const msg = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('slug "notes"'))
      expect(msg).toBeTruthy()
      warn.mockRestore()
    })

    it('keeps both colliding records rather than silently dropping one', async () => {
      // Reporting is the remedy, not repair — only the author can decide which
      // record owns the slug, so the build must not choose for them.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const root = join(testDir, 'entities', 'note')
      writeRecord(root, 'notes.md', 'From markdown')
      writeFileSync(join(root, 'notes.yml'), 'title: From yaml\n')
      const out = await processCollections(testDir, { notes: { name: 'notes', schema: '@/note' } }, undefined, '/')
      expect(out.notes).toHaveLength(2)
      warn.mockRestore()
    })

    it('every record in a flat pool carries the empty path', async () => {
      const root = join(testDir, 'entities', 'flat')
      writeRecord(root, 'a.md', 'A')
      writeRecord(root, 'b.md', 'B')
      const out = await processCollections(
        testDir,
        { flat: { name: 'flat', schema: '@/flat', route: '/f' } },
        undefined,
        '/'
      )
      expect(out.flat.map((i) => i.slug).sort()).toEqual(['a', 'b'])
      expect(out.flat.every((i) => i.path === '')).toBe(true)
      expect(out.flat.map((i) => i.route).sort()).toEqual(['/f/a', '/f/b'])
    })
  })

  describe('processCollections', () => {
    it('should process markdown files into collection items', async () => {
      // Create test library folder
      const contentDir = join(testDir, 'entities', 'articles')
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
          schema: '@/articles',
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
      expect(article.content).toBeDefined()
      expect(article.content.type).toBe('doc') // ProseMirror document
      expect(article.excerpt).toBeDefined()
    })

    it('should exclude unpublished items', async () => {
      const contentDir = join(testDir, 'entities', 'articles')
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
        articles: '@/articles'
      })

      expect(collections.articles).toHaveLength(1)
      expect(collections.articles[0].title).toBe('Published Article')
    })

    it('should apply filter expressions', async () => {
      const contentDir = join(testDir, 'entities', 'posts')
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
          schema: '@/posts',
          filter: 'category == tutorial'
        }
      })

      expect(collections.posts).toHaveLength(1)
      expect(collections.posts[0].title).toBe('Post 1')
    })

    it('should sort items by field', async () => {
      const contentDir = join(testDir, 'entities', 'items')
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
          schema: '@/items',
          sort: 'order asc'
        }
      })

      expect(collections.items.map(i => i.title)).toEqual(['B', 'C', 'A'])
    })

    it('should limit number of items', async () => {
      const contentDir = join(testDir, 'entities', 'posts')
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
          schema: '@/posts',
          sort: 'order asc',
          limit: 3
        }
      })

      expect(collections.posts).toHaveLength(3)
    })

    it('should handle missing collection folder gracefully', async () => {
      const collections = await processCollections(testDir, {
        articles: '@/nonexistent'
      })

      expect(collections.articles).toEqual([])
    })

    it('should return empty object for no collections config', async () => {
      const collections = await processCollections(testDir, null)
      expect(collections).toEqual({})
    })

    it('should add route to items when collection has route config', async () => {
      const contentDir = join(testDir, 'entities', 'articles')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'my-article.md'), `---
title: My Article
---

Content here.
`)

      const collections = await processCollections(testDir, {
        articles: {
          schema: '@/articles',
          route: '/blog'
        }
      })

      expect(collections.articles).toHaveLength(1)
      expect(collections.articles[0].route).toBe('/blog/my-article')
    })

    it('should handle trailing slash in route config', async () => {
      const contentDir = join(testDir, 'entities', 'posts')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'test-post.md'), `---
title: Test Post
---

Content.
`)

      const collections = await processCollections(testDir, {
        posts: {
          schema: '@/posts',
          route: '/news/'
        }
      })

      expect(collections.posts[0].route).toBe('/news/test-post')
    })

    it('should not add route when route config is absent', async () => {
      const contentDir = join(testDir, 'entities', 'items')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'item.md'), `---
title: Item
---

Content.
`)

      const collections = await processCollections(testDir, {
        items: '@/items'
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

      const outputPath = join(testDir, 'public', DATA_DIR, 'articles.json')
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

  describe('YAML array-form items', () => {
    it('should parse a top-level YAML array as multiple items', async () => {
      const contentDir = join(testDir, 'entities', 'team')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'all.yml'), `- slug: alice
  name: Alice
  role: engineer
- slug: bob
  name: Bob
  role: designer
- slug: carol
  name: Carol
  role: writer
`)

      const collections = await processCollections(testDir, {
        team: '@/team'
      })

      expect(collections.team).toHaveLength(3)
      expect(collections.team.map(i => i.slug)).toEqual(['alice', 'bob', 'carol'])
      expect(collections.team[0].name).toBe('Alice')
      expect(collections.team[1].role).toBe('designer')
    })

    it('should mix array-form and mapping-form YAML in the same folder', async () => {
      const contentDir = join(testDir, 'entities', 'team')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'core.yml'), `- slug: alice
  name: Alice
- slug: bob
  name: Bob
`)

      writeFileSync(join(contentDir, 'carol.yml'), `name: Carol
role: writer
`)

      const collections = await processCollections(testDir, {
        team: '@/team'
      })

      expect(collections.team).toHaveLength(3)
      const slugs = collections.team.map(i => i.slug).sort()
      expect(slugs).toEqual(['alice', 'bob', 'carol'])
      expect(collections.team.find(i => i.slug === 'carol').role).toBe('writer')
    })

    it('should preserve mapping-form YAML behavior (slug from filename)', async () => {
      const contentDir = join(testDir, 'entities', 'team')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'alice.yml'), `name: Alice
role: engineer
`)

      const collections = await processCollections(testDir, {
        team: '@/team'
      })

      expect(collections.team).toHaveLength(1)
      expect(collections.team[0].slug).toBe('alice')
      expect(collections.team[0].name).toBe('Alice')
    })
  })

  describe('BibTeX collections', () => {
    it('should parse a .bib file into CSL-JSON items with id as slug', async () => {
      const contentDir = join(testDir, 'entities', 'bibliography')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'refs.bib'), `@book{darwin1859,
  author = {Darwin, Charles},
  title = {On the Origin of Species},
  publisher = {John Murray},
  year = {1859}
}

@article{mendel1866,
  author = {Mendel, Gregor},
  title = {Versuche {\\"u}ber Pflanzenhybriden},
  journal = {Verhandlungen},
  year = {1866}
}
`)

      const collections = await processCollections(testDir, {
        bibliography: '@/bibliography'
      })

      expect(collections.bibliography).toHaveLength(2)

      const byId = Object.fromEntries(collections.bibliography.map(i => [i.id, i]))

      expect(byId.darwin1859.slug).toBe('darwin1859')
      expect(byId.darwin1859.type).toBe('book')
      expect(byId.darwin1859.title).toBe('On the Origin of Species')
      expect(byId.darwin1859.publisher).toBe('John Murray')
      expect(byId.darwin1859.author[0]).toEqual({ family: 'Darwin', given: 'Charles' })

      expect(byId.mendel1866.slug).toBe('mendel1866')
      expect(byId.mendel1866.type).toBe('article-journal')
      expect(byId.mendel1866.title).toContain('über')
    })

    it('should merge .bib and .yml entries in the same collection folder', async () => {
      const contentDir = join(testDir, 'entities', 'bibliography')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'main.bib'), `@book{darwin1859,
  author = {Darwin, Charles},
  title = {On the Origin of Species},
  year = {1859}
}
`)

      writeFileSync(join(contentDir, 'wallace1858.yml'), `id: wallace1858
type: article-journal
author: "Wallace, Alfred"
title: "On the Tendency of Varieties"
year: 1858
`)

      const collections = await processCollections(testDir, {
        bibliography: '@/bibliography'
      })

      const slugs = collections.bibliography.map(i => i.slug).sort()
      expect(slugs).toEqual(['darwin1859', 'wallace1858'])
    })

    it('should merge entries from multiple .bib files in the same folder', async () => {
      const contentDir = join(testDir, 'entities', 'bibliography')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'primary.bib'), `@book{darwin1859,
  author = {Darwin, Charles},
  title = {On the Origin of Species},
  year = {1859}
}
`)

      writeFileSync(join(contentDir, 'secondary.bib'), `@article{wallace1858,
  author = {Wallace, Alfred Russel},
  title = {On the Tendency of Varieties},
  journal = {Journal of the Linnean Society},
  year = {1858}
}

@book{lyell1830,
  author = {Lyell, Charles},
  title = {Principles of Geology},
  year = {1830}
}
`)

      const collections = await processCollections(testDir, {
        bibliography: '@/bibliography'
      })

      expect(collections.bibliography).toHaveLength(3)
      const slugs = collections.bibliography.map(i => i.slug).sort()
      expect(slugs).toEqual(['darwin1859', 'lyell1830', 'wallace1858'])
    })

    it('should treat the BibTeX cite key as slug for per-record file emission', async () => {
      const contentDir = join(testDir, 'entities', 'bibliography')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'refs.bib'), `@book{darwin1859,
  author = {Darwin, Charles},
  title = {On the Origin of Species},
  year = {1859}
}
`)

      const collections = await processCollections(testDir, {
        bibliography: {
          schema: '@/bibliography',
          deferred: ['author']
        }
      })

      await writeCollectionFiles(testDir, collections, {
        bibliography: {
          schema: '@/bibliography',
          deferred: ['author']
        }
      })

      const recordPath = join(testDir, 'public', DATA_DIR, 'bibliography', 'darwin1859.json')
      expect(existsSync(recordPath)).toBe(true)

      const record = JSON.parse(readFileSync(recordPath, 'utf-8'))
      expect(record.author[0].family).toBe('Darwin')
    })
  })

  describe('excerpt extraction', () => {
    it('should auto-extract excerpt from content', async () => {
      const contentDir = join(testDir, 'entities', 'posts')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'post.md'), `---
title: Post
---

This is the first paragraph of the article that should become the excerpt.

This is the second paragraph.
`)

      const collections = await processCollections(testDir, {
        posts: '@/posts'
      })

      expect(collections.posts[0].excerpt).toContain('first paragraph')
    })

    it('should prefer explicit excerpt from frontmatter', async () => {
      const contentDir = join(testDir, 'entities', 'posts')
      mkdirSync(contentDir, { recursive: true })

      writeFileSync(join(contentDir, 'post.md'), `---
title: Post
excerpt: Custom excerpt here
---

This is the body content.
`)

      const collections = await processCollections(testDir, {
        posts: '@/posts'
      })

      expect(collections.posts[0].excerpt).toBe('Custom excerpt here')
    })
  })
})
