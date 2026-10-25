/**
 * A language's projections (`site/projections.js`): its search index, its agent index and each of its
 * pages as markdown, record pages included — one rule for the bundle's default language, the
 * localized build's other ones, and the dev server. ⛔ Until 2026-10-25 a language other than the
 * default got a search index of its pages alone and no `llms.txt` or `.md`.
 */
import { markdownToProseMirror } from '@uniweb/content-reader'
import { agentFiles, describeProjections, projectionFiles, searchFiles } from '../src/site/projections.js'
import { recordProjections } from '../src/site/record-projections.js'

const ADDRESS = 'https://example.org/notes/'

const section = (markdown) => ({ id: 0, type: 'Section', params: {}, content: markdownToProseMirror(markdown), subsections: [] })
const page = (route, title, markdown, extra = {}) => ({ route, title, description: '', hasContent: true, sections: [section(markdown)], ...extra })
const container = (route, title) => ({ route, title, description: '', hasContent: false, sections: [] })

/** A site with a blog of records, in `locale` when one is given — its default is `en`. */
function blogSite({ locale, config = {}, pages = [] } = {}) {
  return {
    config: {
      name: 'Field Notes',
      defaultLanguage: 'en',
      languages: ['en', 'fr'],
      search: true,
      queries: { posts: { schema: '@/post' } },
      i18n: { routeTranslations: { fr: { '/blog': '/actualites', '/about': '/a-propos' } } },
      ...(locale ? { activeLocale: locale } : {}),
      ...config
    },
    pages: [
      page('/', 'Home', '# Home\n\nWelcome.'),
      page('/about', 'About', '# About\n\nWho we are.'),
      page('/blog', 'Blog', '# Blog\n\nThe latest.', { fetch: { query: 'posts', path: '/data/posts.json', as: 'posts' } }),
      { route: '/blog/:slug', parent: '/blog', isDynamic: true, title: 'Post', hasContent: true, sections: [] },
      ...pages
    ]
  }
}

/** Each language's compiled records, as `recordProjections` reads them. */
const POSTS = {
  en: {
    '/data/posts.json': [{ $name: 'first-light', title: 'First light', excerpt: 'The morning.' }],
    '/data/posts/first-light.json': { $name: 'first-light', title: 'First light', body: 'The whole post.' }
  },
  fr: {
    '/data/posts.json': [{ $name: 'first-light', title: 'Premiere lumiere', excerpt: 'Le matin.' }],
    '/data/posts/first-light.json': { $name: 'first-light', title: 'Premiere lumiere', body: 'Le texte entier.' }
  }
}
const recordsOf = (content, locale = 'en') => recordProjections(content, { read: (path) => POSTS[locale][path] ?? null })

describe('a language\'s projections', () => {
  test('⭐ another language\'s files: under its prefix, at its translated routes, its records among them', async () => {
    const content = blogSite({ locale: 'fr' })
    const files = projectionFiles(content, await recordsOf(content, 'fr'))
    const byName = Object.fromEntries(files.map((file) => [file.fileName, file]))

    expect(Object.keys(byName).sort()).toEqual([
      'fr/a-propos.md',
      'fr/actualites.md',
      'fr/actualites/first-light.md',
      'fr/index.md',
      'fr/llms.txt',
      'fr/search-index.json'
    ])
    const index = JSON.parse(byName['fr/search-index.json'].source)
    expect(index.locale).toBe('fr')
    // A result's route is the site's own, as a page's is: a link is localized as any link is.
    expect(index.entries.filter((e) => e.type === 'record').map((e) => [e.route, e.title])).toEqual([
      ['/blog/first-light', 'Premiere lumiere']
    ])
    expect(byName['fr/llms.txt'].source).toContain('[Premiere lumiere](/fr/actualites/first-light.md)')
    expect(byName['fr/actualites/first-light.md'].source).toContain('Le texte entier.')
  })

  test('the default language\'s are at the root, at its own routes', async () => {
    const content = blogSite()
    const names = projectionFiles(content, await recordsOf(content)).map((file) => file.fileName)
    expect(names.sort()).toEqual(['about.md', 'blog.md', 'blog/first-light.md', 'index.md', 'llms.txt', 'search-index.json'])
  })

  test.each([
    ['the default language', undefined, null],
    ['another language', 'fr', null],
    ['the default language, on an address', undefined, ADDRESS],
    ['another language, on an address', 'fr', ADDRESS]
  ])('⭐ in %s, every page llms.txt links is a file written, and every file written is linked', async (_, locale, url) => {
    const content = blogSite({ locale, config: url ? { url } : {} })
    const files = projectionFiles(content, await recordsOf(content, locale || 'en'))
    const markdown = new Set(files.filter((file) => file.kind === 'markdown').map((file) => file.fileName))
    const llms = files.find((file) => file.kind === 'index').source
    const linked = [...llms.matchAll(/\]\(([^)]+\.md)\)/g)].map(([, href]) =>
      decodeURIComponent(url ? href.slice(url.length) : href.replace(/^\//, ''))
    )
    // Home, About, Blog and its one record — never the record pages' template.
    expect(linked.length).toBe(4)
    expect(new Set(linked)).toEqual(markdown)
  })

  test('a record under a branch llms.txt leaves out gets no file, as it gets no line', async () => {
    const content = blogSite()
    // The blog a hidden group: its records are no more listed than its pages.
    content.pages = content.pages.map((p) => (p.route === '/blog' ? { ...p, hasContent: false, hidden: true, sections: [] } : p))
    const files = agentFiles(content, await recordsOf(content))
    expect(files.map((file) => file.fileName)).not.toContain('blog/first-light.md')
    expect(files.find((file) => file.kind === 'index').source).not.toContain('first-light')
  })

  test('a knowledge page, and the branch under it, reach no projection', async () => {
    const content = blogSite({
      pages: [
        page('/kb', 'KB', '# KB\n\nFor the assistant: zebranaut.', { knowledge: true }),
        page('/kb/pricing', 'Pricing', '# Pricing\n\nThe playbook.')
      ]
    })
    const files = projectionFiles(content, await recordsOf(content))
    const names = files.map((file) => file.fileName)
    expect(names).not.toContain('kb.md')
    expect(names).not.toContain('kb/pricing.md')
    expect(files.map((file) => file.source).join('\n')).not.toContain('zebranaut')
    // Control: the public pages are there, so the absences are selection.
    expect(names).toContain('about.md')
  })

  test('a branch index is at the branch\'s address in its language', () => {
    const content = blogSite({
      locale: 'fr',
      config: { agents: { branchMinPages: 2 }, i18n: { routeTranslations: { fr: { '/docs': '/documentation' } } } },
      pages: [container('/docs', 'Docs'), page('/docs/a', 'A', '# A\n\nOne.'), page('/docs/b', 'B', '# B\n\nTwo.')]
    })
    const branch = agentFiles(content, { entries: [], pages: [] }).find((file) => file.kind === 'branch')
    expect(branch.fileName).toBe('fr/documentation/llms.txt')
    expect(branch.source).toContain('(/fr/documentation/a.md)')
  })

  test('what the site turns off it does not get: search, agent files, markdown alone', async () => {
    const records = await recordsOf(blogSite())
    expect(searchFiles(blogSite({ config: { search: false } }), records)).toEqual([])
    expect(agentFiles(blogSite({ config: { agents: false } }), records)).toEqual([])
    expect(agentFiles(blogSite({ config: { agents: { markdown: false } } }), records).map((file) => file.kind)).toEqual(['index'])
  })

  test('what a build says it wrote', async () => {
    const content = blogSite({ locale: 'fr' })
    const files = projectionFiles(content, await recordsOf(content, 'fr'))
    const { count } = JSON.parse(files.find((file) => file.kind === 'search').source)
    expect(describeProjections(files)).toEqual([
      `Generated fr/search-index.json (${count} entries)`,
      'Generated fr/llms.txt',
      'Generated 4 page markdown projections'
    ])
  })
})
