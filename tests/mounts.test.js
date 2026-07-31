/**
 * Page mounts — `paths: { pages/<segment>: <dir> }` in site.yml.
 *
 * These are the feature's first tests. Everything here asserts on the collected
 * output rather than on intermediate config, because every bug this file was
 * written for shared one shape: the declaration was read, accepted, and never
 * reached the pages.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

let root

/**
 * A site plus a separate content directory to mount into it. The content dir is
 * a sibling of the site, the way a submodule under external/ would be.
 */
async function makeWorkspace({ siteYml, localDocs = null, mountFiles = {} }) {
  root = await mkdtemp(join(tmpdir(), 'uniweb-mount-'))
  const siteDir = join(root, 'site')
  const mountDir = join(root, 'external', 'docs')

  await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
  await writeFile(join(siteDir, 'site.yml'), siteYml)
  await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Home\n')

  await mkdir(mountDir, { recursive: true })
  for (const [rel, body] of Object.entries(mountFiles)) {
    const full = join(mountDir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }

  if (localDocs) {
    await mkdir(join(siteDir, 'pages', 'docs'), { recursive: true })
    for (const [rel, body] of Object.entries(localDocs)) {
      await writeFile(join(siteDir, 'pages', 'docs', rel), body)
    }
  }

  return siteDir
}

// Two sections, deliberately in an order that alphabetical sorting would undo.
const TWO_SECTIONS = {
  'folder.yml': 'title: Documentation\npages: [guides, api]\n',
  'guides/folder.yml': 'title: Guides\n',
  'guides/intro.md': '# Intro\n',
  'api/folder.yml': 'title: API\n',
  'api/reference.md': '# Reference\n',
}

// `index:` matters here — without it the root promotes its alphabetically
// first folder to `/`, which would be the mount.
const MOUNT_YML = 'name: Test\nindex: home\npaths:\n  pages/docs: ../external/docs\n'

const routes = content => content.pages.map(p => p.route)

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('page mounts — content reaches the routes', () => {
  it('mounts an external directory with no local folder at all', async () => {
    const siteDir = await makeWorkspace({ siteYml: MOUNT_YML, mountFiles: TWO_SECTIONS })

    const content = await collectSiteContent(siteDir)

    expect(routes(content)).toEqual(
      expect.arrayContaining(['/docs', '/docs/guides', '/docs/guides/intro', '/docs/api/reference'])
    )
  })

  it('takes the branch title from the mounted directory', async () => {
    const siteDir = await makeWorkspace({ siteYml: MOUNT_YML, mountFiles: TWO_SECTIONS })

    const content = await collectSiteContent(siteDir)

    expect(content.pages.find(p => p.route === '/docs').title).toBe('Documentation')
  })
})

describe('page mounts — a local folder layers over the mount', () => {
  it('keeps the mounted ordering when the local stub does not declare one', async () => {
    // The regression this file exists for. A local folder is the only place
    // `layout:` can be declared for a mounted route, and declaring it used to
    // discard the mounted repo's own folder.yml wholesale — silently reordering
    // the branch alphabetically.
    const siteDir = await makeWorkspace({
      siteYml: MOUNT_YML,
      localDocs: { 'folder.yml': 'layout: DocsLayout\n' },
      mountFiles: TWO_SECTIONS,
    })

    const content = await collectSiteContent(siteDir)
    const branch = routes(content).filter(r => r === '/docs/guides' || r === '/docs/api')

    expect(branch).toEqual(['/docs/guides', '/docs/api'])
  })

  it('applies the local layout to the branch and everything under it', async () => {
    const siteDir = await makeWorkspace({
      siteYml: MOUNT_YML,
      localDocs: { 'folder.yml': 'layout: DocsLayout\n' },
      mountFiles: TWO_SECTIONS,
    })

    const content = await collectSiteContent(siteDir)

    for (const route of ['/docs', '/docs/guides', '/docs/guides/intro']) {
      expect(content.pages.find(p => p.route === route).layout.name).toBe('DocsLayout')
    }
  })

  it('lets the local stub win per key without dropping the rest', async () => {
    const siteDir = await makeWorkspace({
      siteYml: MOUNT_YML,
      localDocs: { 'folder.yml': 'title: Handbook\nlayout: DocsLayout\n' },
      mountFiles: TWO_SECTIONS,
    })

    const content = await collectSiteContent(siteDir)
    const branch = content.pages.find(p => p.route === '/docs')

    // title: local wins. pages: only the mount declared it, so it still applies.
    expect(branch.title).toBe('Handbook')
    expect(routes(content).filter(r => r === '/docs/guides' || r === '/docs/api'))
      .toEqual(['/docs/guides', '/docs/api'])
  })

  it('lets the local stub override the mounted ordering when it declares one', async () => {
    const siteDir = await makeWorkspace({
      siteYml: MOUNT_YML,
      localDocs: { 'folder.yml': 'pages: [api, guides]\n' },
      mountFiles: TWO_SECTIONS,
    })

    const content = await collectSiteContent(siteDir)

    expect(routes(content).filter(r => r === '/docs/guides' || r === '/docs/api'))
      .toEqual(['/docs/api', '/docs/guides'])
  })

  it('walks the mounted tree in the mount\'s own content mode', async () => {
    // The local stub is a page.yml — page mode — but it holds no markdown and
    // the mounted root declares folder mode. Read as page mode, the mounted
    // top-level markdown would collapse into sections of /docs instead of
    // becoming its own page.
    const siteDir = await makeWorkspace({
      siteYml: MOUNT_YML,
      localDocs: { 'page.yml': 'layout: DocsLayout\n' },
      mountFiles: {
        'folder.yml': 'title: Documentation\n',
        'overview.md': '# Overview\n',
      },
    })

    const content = await collectSiteContent(siteDir)

    expect(routes(content)).toContain('/docs/overview')
  })
})

describe('page mounts — a mount that contributes nothing', () => {
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('warns rather than building a silent empty branch', async () => {
    // An unfetched git submodule is an existing, readable, empty directory: it
    // passes every structural check the mount performs.
    const spy = warn()
    const siteDir = await makeWorkspace({ siteYml: MOUNT_YML, mountFiles: {} })

    await collectSiteContent(siteDir)

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('External pages path is empty'))
    expect(spy.mock.calls[0][0]).toContain('git submodule update --init --recursive')
    spy.mockRestore()
  })

  it('fails a strict build instead of shipping it', async () => {
    const spy = warn()
    const siteDir = await makeWorkspace({ siteYml: MOUNT_YML, mountFiles: {} })

    await expect(collectSiteContent(siteDir, { strict: true }))
      .rejects.toThrow(/External pages path is empty/)
    spy.mockRestore()
  })

  it('does not count a README as content', async () => {
    // A repo whose root holds only documentation about itself contributes no
    // pages — isMarkdownFile excludes README.md.
    const spy = warn()
    const siteDir = await makeWorkspace({
      siteYml: MOUNT_YML,
      mountFiles: { 'README.md': '# The docs repo\n' },
    })

    await collectSiteContent(siteDir)

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('External pages path is empty'))
    spy.mockRestore()
  })

  it('stays quiet when the mount has content', async () => {
    const spy = warn()
    const siteDir = await makeWorkspace({ siteYml: MOUNT_YML, mountFiles: TWO_SECTIONS })

    await collectSiteContent(siteDir)

    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('External pages path is empty'))
    spy.mockRestore()
  })
})

describe('page mounts — hidden directories in the mount target', () => {
  it('does not walk a mounted repo\'s .git directory as content', async () => {
    // Only visible when the mount target is a plain git working tree — a
    // sibling clone, which the docs suggest. As a submodule `.git` is a file,
    // so the common setup hides this entirely. Walked as content it contributed
    // several hundred routes.
    const siteDir = await makeWorkspace({
      siteYml: MOUNT_YML,
      mountFiles: {
        ...TWO_SECTIONS,
        '.git/config': '[core]\n',
        '.git/refs/heads/main': 'abc123\n',
        '.github/workflows/ci.yml': 'name: ci\n',
      },
    })

    const content = await collectSiteContent(siteDir)

    expect(routes(content).filter(r => r.includes('/.'))).toEqual([])
    // and the real content is untouched
    expect(routes(content)).toContain('/docs/guides/intro')
  })
})

describe('page mounts — structural validation', () => {
  it('rejects a mount path that does not exist', async () => {
    const siteDir = await makeWorkspace({
      siteYml: 'name: Test\nindex: home\npaths:\n  pages/docs: ../external/nope\n',
      mountFiles: TWO_SECTIONS,
    })

    await expect(collectSiteContent(siteDir)).rejects.toThrow(/does not exist/)
  })

  it('rejects a mount that overlaps the site pages directory', async () => {
    const siteDir = await makeWorkspace({
      siteYml: 'name: Test\nindex: home\npaths:\n  pages/docs: ./pages\n',
      mountFiles: TWO_SECTIONS,
    })

    await expect(collectSiteContent(siteDir)).rejects.toThrow(/overlaps/)
  })

  it('rejects a route segment that is not a simple name', async () => {
    const siteDir = await makeWorkspace({
      siteYml: 'name: Test\nindex: home\npaths:\n  pages/a/b: ../external/docs\n',
      mountFiles: TWO_SECTIONS,
    })

    await expect(collectSiteContent(siteDir)).rejects.toThrow(/Invalid mount/)
  })
})

describe('page mounts — the dev server watches them', () => {
  /**
   * A mount lives outside the site, so the pages/ watcher cannot reach it. When
   * nothing else did either, an author editing a mounted docs repository saw
   * their change ignored until they restarted — and the natural reading of that
   * is that the edit was wrong rather than unwatched.
   *
   * This drives the plugin's real hooks rather than asserting on config,
   * because the bug it guards against is exactly a resolved-but-unused path.
   */
  async function startDevPlugin(siteDir) {
    const { siteContentPlugin } = await import('../src/site/plugin.js')
    const plugin = siteContentPlugin({ sitePath: '.' })

    const watched = []
    const log = console.log
    console.log = (...args) => {
      const line = args.join(' ')
      if (line.includes('[site-content] Watching')) watched.push(line)
    }

    let reloads = 0
    try {
      await plugin.configResolved({
        root: siteDir,
        command: 'serve',
        build: { outDir: 'dist' },
        base: '/',
      })
      await plugin.configureServer({
        ws: { send: () => { reloads++ } },
        middlewares: { use: () => {} },
      })
    } finally {
      console.log = log
    }

    return { watched, reloads: () => reloads }
  }

  /** fs events are asynchronous; poll rather than guess at a sleep duration. */
  async function waitFor(predicate, timeout = 8000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise(r => setTimeout(r, 50))
    }
    return false
  }

  it('registers a watcher on the mounted directory', async () => {
    const siteDir = await makeWorkspace({
      siteYml: 'name: Test\nindex: home\npaths:\n  pages/docs: ../external/docs\n',
      mountFiles: TWO_SECTIONS,
    })

    const { watched } = await startDevPlugin(siteDir)

    expect(watched.some(l => l.includes('external/docs') && l.includes('(mounted)'))).toBe(true)
  })

  it('rebuilds when a file inside the mount changes', async () => {
    const siteDir = await makeWorkspace({
      siteYml: 'name: Test\nindex: home\npaths:\n  pages/docs: ../external/docs\n',
      mountFiles: TWO_SECTIONS,
    })

    const { reloads } = await startDevPlugin(siteDir)
    const target = join(root, 'external', 'docs', 'guides', 'intro.md')

    await writeFile(target, '# Intro, edited in the mount\n')

    expect(await waitFor(() => reloads() > 0)).toBe(true)
  }, 20000)
})
