import { expandDynamicPages } from '../src/prerender.js'

/**
 * Prerender expands a parametric page into one concrete page per record of its
 * ROUTE QUERY (/blog/:slug → /blog/post-1, …). The route query is chosen by the
 * rule every lane reads it with (`routeQuery`, `@uniweb/core/fetch-config`): the
 * page's own query, its parent's, the site's, or its sections' shared key.
 *
 * Static children must win over that catch-all — the SPA's Website.getPage
 * checks exact static routes before the `:param` loop, so SSG has to match it.
 * The write loops downstream are keyed on `page.route` and last-writer-wins, so
 * an unguarded collision (a record whose slug equals a static sibling's segment)
 * would silently overwrite the static page's HTML.
 */

const noop = () => {}
const blog = (as = 'articles') => ({ route: '/blog', isDynamic: false, fetch: { query: as, path: `/data/${as}.json`, as } })
/** What the parent page fetched, by binding key — the shape `executeAllFetches` records. */
const parentData = (items, as = 'articles', route = '/blog') => ({ pages: new Map([[route, new Map([[as, items]])]]) })

describe('expandDynamicPages', () => {
  const template = { route: '/blog/:slug', isDynamic: true, paramName: 'slug' }

  it('expands one concrete page per record', () => {
    const out = expandDynamicPages([blog(), template], parentData([{ slug: 'post-1' }, { slug: 'post-2' }]), noop)
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
    const out = expandDynamicPages([blog(), staticAbout, template], parentData([{ slug: 'about' }, { slug: 'post-1' }]), noop)

    // Exactly one page claims /blog/about, and it's the static one.
    const aboutPages = out.filter((p) => p.route === '/blog/about')
    expect(aboutPages).toHaveLength(1)
    expect(aboutPages[0]).toBe(staticAbout)
    expect(aboutPages[0].dynamicContext).toBeUndefined()

    // The non-colliding record still expands.
    expect(out.some((p) => p.route === '/blog/post-1')).toBe(true)
  })

  it('bakes the route binding into dynamicContext — the three variables, no `schema`, never the records', () => {
    // allItems/currentItem used to be embedded here, duplicating the whole
    // collection onto every prerendered page. The runtime re-finds the record
    // from the fetched collection, so only the routing keys are needed — and the
    // key the URL narrows is worked out where it is read (`schema` deleted 2026-09-11).
    const items = [
      { slug: 'post-1', title: 'One', body: 'x'.repeat(5000) },
      { slug: 'post-2', title: 'Two', body: 'y'.repeat(5000) },
    ]
    const out = expandDynamicPages([blog(), template], parentData(items), noop)
    const post1 = out.find((p) => p.route === '/blog/post-1')
    expect(post1.dynamicContext).toEqual({
      templateRoute: '/blog/:slug',
      params: { slug: 'post-1', path: 'post-1', dir: '' },
      paramName: 'slug',
      paramValue: 'post-1',
    })
    // No record data leaked in via the context (neither the item nor its siblings).
    expect(JSON.stringify(post1.dynamicContext)).not.toContain('body')
    expect(JSON.stringify(post1.dynamicContext)).not.toContain('post-2')
  })

  it('skips records without a param value', () => {
    const out = expandDynamicPages([blog(), template], parentData([{ slug: 'post-1' }, { title: 'no slug' }]), noop)
    expect(out.filter((p) => p.route?.startsWith('/blog/'))).toHaveLength(1)
  })

  it('keeps the template inline when its route query has no build-time data', () => {
    const out = expandDynamicPages([blog(), template], {}, noop)
    expect(out).toContain(template)
    expect(out.find((p) => p.route === '/blog/:slug')?.isDynamic).toBe(true)
  })

  it('keeps the template inline when nothing names a query for its URL to narrow', () => {
    const lines = []
    const out = expandDynamicPages([{ route: '/blog', isDynamic: false }, template], parentData([{ slug: 'x' }]), (l) => lines.push(l))
    expect(out).toContain(template)
    expect(lines.some((l) => l.includes('no query for its URL to narrow'))).toBe(true)
  })
})

describe('the route query decides what a parametric page expands over (ruled 2026-09-11)', () => {
  it('the page\'s own query — the template\'s own `page.yml`', () => {
    const own = { route: '/team/:slug', isDynamic: true, paramName: 'slug', fetch: { query: 'people', path: '/data/people.json', as: 'people' } }
    const out = expandDynamicPages(
      [{ route: '/team', isDynamic: false }, own],
      { pages: new Map([['/team/:slug', new Map([['people', [{ slug: 'ada' }]]])]]) },
      noop,
    )
    expect(out.map((p) => p.route)).toContain('/team/ada')
  })

  it('the site\'s query when the page and its parent declare none', () => {
    const t = { route: '/team/:slug', isDynamic: true, paramName: 'slug' }
    const out = expandDynamicPages(
      [{ route: '/team', isDynamic: false }, t],
      { site: new Map([['people', [{ slug: 'ada' }]]]) },
      noop,
      undefined,
      { siteFetch: { query: 'people', path: '/data/people.json', as: 'people' } },
    )
    expect(out.map((p) => p.route)).toContain('/team/ada')
  })

  it('the FIRST declared query — one that is not prerendered keeps the page for runtime, not the second', () => {
    // ⛔ This expanded over the first PRERENDERED fetch until 2026-09-11, while the
    // SPA narrowed the first declared: two answers to what the URL names.
    const parent = { route: '/blog', isDynamic: false, fetch: [
      { query: 'articles', path: '/data/articles.json', as: 'articles', prerender: false },
      { query: 'authors', path: '/data/authors.json', as: 'authors' },
    ] }
    const t = { route: '/blog/:slug', isDynamic: true, paramName: 'slug' }
    const out = expandDynamicPages([parent, t], parentData([{ slug: 'jane' }], 'authors'), noop)
    expect(out).toContain(t)
    expect(out.map((p) => p.route)).not.toContain('/blog/jane')
  })

  it('[uuid] expands by the record\'s identity, $uuid, else a plain uuid field', () => {
    const t = { route: '/blog/:uuid', isDynamic: true, paramName: 'uuid' }
    const out = expandDynamicPages([blog(), t], parentData([{ $uuid: '019e', slug: 'a' }, { uuid: 'abc' }]), noop)
    expect(out.map((p) => p.route)).toEqual(expect.arrayContaining(['/blog/019e', '/blog/abc']))
  })

  it('[id] expands by the field, whatever its type — the value is a URL segment', () => {
    const t = { route: '/blog/:id', isDynamic: true, paramName: 'id' }
    const out = expandDynamicPages([blog(), t], parentData([{ id: 42 }]), noop)
    const page = out.find((p) => p.route === '/blog/42')
    expect(page.dynamicContext).toMatchObject({ paramName: 'id', paramValue: '42', params: { id: '42', slug: '42' } })
  })

  it('a page nested inside a parametric page expands with it — its route query is the page above', () => {
    const slugPage = { route: '/blog/:slug', isDynamic: true, paramName: 'slug', fetch: { query: 'articles', path: '/data/articles.json', as: 'articles' } }
    const cv = { route: '/blog/:slug/cv', parent: '/blog/:slug', isDynamic: true, paramName: 'slug' }
    const out = expandDynamicPages(
      [blog(), slugPage, cv],
      { pages: new Map([['/blog', new Map([['articles', [{ slug: 'post-1' }]]])], ['/blog/:slug', new Map([['articles', [{ slug: 'post-1' }]]])]]) },
      noop,
    )
    expect(out.map((p) => p.route)).toEqual(expect.arrayContaining(['/blog/post-1', '/blog/post-1/cv']))
  })

  it('a route with a parameter the records cannot fill stays for the runtime', () => {
    const t = { route: '/orgs/:org/members/:slug', isDynamic: true, paramName: 'slug', fetch: { query: 'members', path: '/data/members.json', as: 'members' } }
    const out = expandDynamicPages([t], { pages: new Map([['/orgs/:org/members/:slug', new Map([['members', [{ slug: 'ada' }]]])]]) }, noop)
    expect(out).toContain(t)
  })
})

describe('records with no value for the route param are COUNTED, not only logged', () => {
  const template = { route: '/blog/:slug', isDynamic: true, paramName: 'slug' }

  it('says the total once, naming the template, the param and how many records were affected', () => {
    const lines = []
    expandDynamicPages(
      [blog(), template],
      parentData([{ slug: 'a' }, { title: 'one' }, { title: 'two' }, { slug: 'b' }, { title: 'three' }]),
      (l) => lines.push(l)
    )
    const summary = lines.filter((l) => l.includes('no page was generated'))
    expect(summary).toHaveLength(1)
    expect(summary[0]).toContain('3 of 5')
    expect(summary[0]).toContain('"slug"')
    expect(summary[0]).toContain('/blog/:slug')
    // and no longer one line per record
    expect(lines.filter((l) => l.includes('Skipping item without'))).toHaveLength(0)
  })

  it('hands the count back on `stats` so a caller can assert or refuse on it', () => {
    const stats = {}
    expandDynamicPages([blog(), template], parentData([{ slug: 'a' }, { title: 'unnamed' }]), noop, stats)
    expect(stats.unrouted).toEqual({ '/blog/:slug': 1 })
  })

  it('CONTROL — says nothing when every record has the param', () => {
    const lines = []
    const stats = {}
    expandDynamicPages([blog(), template], parentData([{ slug: 'a' }]), (l) => lines.push(l), stats)
    expect(lines.some((l) => l.includes('no page was generated'))).toBe(false)
    expect(stats.unrouted).toEqual({})
  })
})

describe('a [...path] template expands over placement + handle', () => {
  const template = { route: '/blog/:path*', isDynamic: true, paramName: 'slug' }

  it('emits one page per record at <placement>/<slug>, with the three variables baked', () => {
    const out = expandDynamicPages(
      [blog('posts'), template],
      parentData([{ slug: 'my-post', path: 'rust/2025' }, { slug: 'top', path: '' }], 'posts'),
      noop
    )
    const routes = out.map((p) => p.route)
    expect(routes).toContain('/blog/rust/2025/my-post')
    expect(routes).toContain('/blog/top')
    const deep = out.find((p) => p.route === '/blog/rust/2025/my-post')
    expect(deep.dynamicContext).toEqual({
      templateRoute: '/blog/:path*',
      params: { path: 'rust/2025/my-post', dir: 'rust/2025', slug: 'my-post' },
      paramName: 'slug',
      paramValue: 'my-post',
    })
    expect(out.find((p) => p.route === '/blog/top').dynamicContext.params).toEqual({ path: 'top', dir: '', slug: 'top' })
  })

  it('a record with no slug is counted as unrouted, as under [slug]', () => {
    const stats = {}
    expandDynamicPages([blog('posts'), template], parentData([{ path: 'a', title: 'x' }], 'posts'), noop, stats)
    expect(stats.unrouted).toEqual({ '/blog/:path*': 1 })
  })
})

describe('a `multi` route field expands member-wise (ruled 2026-09-12 [Diego])', () => {
  // The case the rule is for is not tag pages: it is a Model field TYPED `multi`
  // that holds ONE value — `department: ['biology']` — which an author routes as
  // `[department]` and thinks of as a scalar. Expanded whole it baked
  // `/depts/biology` only by accident of `String(['biology'])`; two values baked
  // `/tags/a%2Cb`, a URL no lane matches.
  const list = { route: '/tags', isDynamic: false, fetch: { query: 'items', path: '/data/items.json', as: 'items' } }
  const template = { route: '/tags/:tag', isDynamic: true, paramName: 'tag' }
  const data = (items) => parentData(items, 'items', '/tags')

  it('one page per member, and a `multi` holding one value gets exactly one', () => {
    const out = expandDynamicPages([list, template], data([
      { slug: 'a', tag: ['x', 'y'] },
      { slug: 'b', tag: ['z'] },
      { slug: 'c', tag: 'plain' },
    ]), noop)
    const routes = out.map((p) => p.route).filter((r) => r.startsWith('/tags/'))
    expect(routes.sort()).toEqual(['/tags/plain', '/tags/x', '/tags/y', '/tags/z'])
  })

  it('each page binds the member it was expanded for', () => {
    const out = expandDynamicPages([list, template], data([{ slug: 'a', tag: ['x', 'y'] }]), noop)
    expect(out.find((p) => p.route === '/tags/y').dynamicContext).toMatchObject({
      templateRoute: '/tags/:tag',
      paramName: 'tag',
      paramValue: 'y',
    })
  })

  it('⛔ two records claiming one route — the first keeps it, and the build says so', () => {
    // A non-unique route field makes ties normal. Which record is first is this
    // lane's order and a hosted site orders by its own store, so it is said out
    // loud rather than discovered as a different record on the same URL.
    const said = []
    const out = expandDynamicPages([list, template], data([
      { slug: 'a', tag: ['x'] },
      { slug: 'b', tag: ['x'] },
    ]), (m) => said.push(m))
    expect(out.filter((p) => p.route === '/tags/x')).toHaveLength(1)
    expect(out.find((p) => p.route === '/tags/x').title).toBeUndefined()
    expect(said.some((m) => /claimed by more than one items record/.test(m))).toBe(true)
  })

  it('empty and duplicate members drop; a record with none is counted unrouted', () => {
    const stats = { unrouted: {} }
    const out = expandDynamicPages([list, template], data([
      { slug: 'a', tag: ['x', '', 'x', null] },
      { slug: 'b' },
      { slug: 'c', tag: [] },
    ]), noop, stats)
    expect(out.map((p) => p.route).filter((r) => r.startsWith('/tags/'))).toEqual(['/tags/x'])
    expect(stats.unrouted['/tags/:tag']).toBe(2)
  })
})
