import { expandDynamicPages } from '../src/prerender.js'

/**
 * Prerender expands a `[slug]` template into one concrete page per record
 * (/blog/:slug → /blog/post-1, …). Static children must win over that
 * catch-all — the SPA's Website.getPage checks exact static routes before the
 * `:param` loop, so SSG has to match it. The write loops downstream are keyed
 * on `page.route` and last-writer-wins, so an unguarded collision (a record
 * whose slug equals a static sibling's segment) would silently overwrite the
 * static page's HTML. These guard the static-precedence skip.
 */
describe('expandDynamicPages', () => {
  const noop = () => {}

  const template = {
    route: '/blog/:slug',
    isDynamic: true,
    paramName: 'slug',
    parentSchema: 'articles',
  }

  const withData = (items) => {
    const map = new Map()
    map.set('/blog', { schema: 'articles', data: items })
    return map
  }

  it('expands one concrete page per record', () => {
    const pages = [{ route: '/blog', isDynamic: false }, template]
    const out = expandDynamicPages(
      pages,
      withData([{ slug: 'post-1' }, { slug: 'post-2' }]),
      noop
    )
    const routes = out.map((p) => p.route)
    expect(routes).toContain('/blog/post-1')
    expect(routes).toContain('/blog/post-2')
    expect(out.every((p) => !p.isDynamic)).toBe(true)
  })

  it('skips a record whose route collides with a static sibling (static wins)', () => {
    // A static /blog/about authored alongside the [slug] template, and a record
    // that also carries slug:'about'. The static page must survive; the record
    // is skipped rather than clobbering it.
    const staticAbout = { route: '/blog/about', isDynamic: false }
    const pages = [{ route: '/blog', isDynamic: false }, staticAbout, template]
    const out = expandDynamicPages(
      pages,
      withData([{ slug: 'about' }, { slug: 'post-1' }]),
      noop
    )

    // Exactly one page claims /blog/about, and it's the static one.
    const aboutPages = out.filter((p) => p.route === '/blog/about')
    expect(aboutPages).toHaveLength(1)
    expect(aboutPages[0]).toBe(staticAbout)
    expect(aboutPages[0].dynamicContext).toBeUndefined()

    // The non-colliding record still expands.
    expect(out.some((p) => p.route === '/blog/post-1')).toBe(true)
  })

  it('skips records without a param value', () => {
    const pages = [{ route: '/blog', isDynamic: false }, template]
    const out = expandDynamicPages(
      pages,
      withData([{ slug: 'post-1' }, { title: 'no slug' }]),
      noop
    )
    expect(out.filter((p) => p.route?.startsWith('/blog/'))).toHaveLength(1)
  })

  it('keeps the template inline when the parent has no build-time data', () => {
    const pages = [{ route: '/blog', isDynamic: false }, template]
    const out = expandDynamicPages(pages, new Map(), noop)
    expect(out).toContain(template)
    expect(out.find((p) => p.route === '/blog/:slug')?.isDynamic).toBe(true)
  })
})
