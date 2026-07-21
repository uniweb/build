import { join } from 'node:path'
import { shouldRegenerateForFile, getStructuralWatchPaths } from '../src/generate-entry.js'

/**
 * `shouldRegenerateForFile` decides whether a watcher event re-runs
 * generateEntryPoint(). It receives paths straight from a watcher, which means
 * native separators: chokidar normalizes emitted paths with path.normalize() on
 * Windows, and the srcDir it is compared against comes from path.resolve().
 *
 * The prefix check used to be `file.startsWith(srcDir + '/')`, which no
 * Windows path can satisfy — so on Windows the function always returned null,
 * entry regeneration never fired, and adding a section did nothing until the
 * dev server was restarted. These cases pin both separator styles.
 */
describe('shouldRegenerateForFile', () => {
  describe('posix paths', () => {
    const src = '/home/dev/my-site/foundation'

    it('matches a section entry file', () => {
      expect(shouldRegenerateForFile(`${src}/sections/Hero/index.jsx`, src)).toMatch(
        /section entry/
      )
    })

    it('matches a bare section file', () => {
      expect(shouldRegenerateForFile(`${src}/sections/Hero.jsx`, src)).toMatch(/section file/)
    })

    it('matches meta.js at any depth', () => {
      expect(shouldRegenerateForFile(`${src}/sections/Hero/meta.js`, src)).toBe('meta.js changed')
      expect(shouldRegenerateForFile(`${src}/meta.js`, src)).toBe('meta.js changed')
    })

    it('matches root config and style files', () => {
      expect(shouldRegenerateForFile(`${src}/main.js`, src)).toBe('foundation config changed')
      expect(shouldRegenerateForFile(`${src}/styles.css`, src)).toBe('foundation styles changed')
    })

    it('ignores non-structural files', () => {
      expect(shouldRegenerateForFile(`${src}/components/Card.jsx`, src)).toBeNull()
      expect(shouldRegenerateForFile(`${src}/sections/Hero/styles.css`, src)).toBeNull()
    })

    it('ignores files outside the source root', () => {
      expect(shouldRegenerateForFile('/home/dev/elsewhere/sections/Hero.jsx', src)).toBeNull()
    })
  })

  describe('windows paths', () => {
    const src = 'C:\\Users\\dev\\my-site\\foundation'

    it('matches a section entry file', () => {
      expect(shouldRegenerateForFile(`${src}\\sections\\Hero\\index.jsx`, src)).toMatch(
        /section entry/
      )
    })

    it('matches a bare section file', () => {
      expect(shouldRegenerateForFile(`${src}\\sections\\Hero.jsx`, src)).toMatch(/section file/)
    })

    it('matches meta.js at any depth', () => {
      expect(shouldRegenerateForFile(`${src}\\sections\\Hero\\meta.js`, src)).toBe(
        'meta.js changed'
      )
      expect(shouldRegenerateForFile(`${src}\\meta.js`, src)).toBe('meta.js changed')
    })

    it('matches a layout entry file', () => {
      expect(shouldRegenerateForFile(`${src}\\layouts\\docs\\index.jsx`, src)).toMatch(
        /layout entry/
      )
    })

    it('matches root config and style files', () => {
      expect(shouldRegenerateForFile(`${src}\\main.js`, src)).toBe('foundation config changed')
      expect(shouldRegenerateForFile(`${src}\\styles.css`, src)).toBe('foundation styles changed')
    })

    it('ignores non-structural files', () => {
      expect(shouldRegenerateForFile(`${src}\\components\\Card.jsx`, src)).toBeNull()
    })

    it('ignores files outside the source root', () => {
      expect(
        shouldRegenerateForFile('C:\\Users\\dev\\elsewhere\\sections\\Hero.jsx', src)
      ).toBeNull()
    })
  })

  it('tolerates a trailing separator on the source root', () => {
    expect(shouldRegenerateForFile('/a/b/sections/Hero.jsx', '/a/b/')).toMatch(/section file/)
  })
})

/**
 * The watch surface and the match predicate have to agree: a watcher fed only
 * these paths must still see every event the predicate would act on. The point
 * of the list is that it excludes the source root itself — under the flat
 * layout that root is the foundation package root, and watching it descends
 * into node_modules/.
 */
describe('getStructuralWatchPaths', () => {
  const src = join('/home/dev/my-site/foundation')

  it('never returns the source root itself', () => {
    expect(getStructuralWatchPaths(src)).not.toContain(src)
  })

  it('covers every structural path the predicate matches', () => {
    const paths = getStructuralWatchPaths(src)
    const covered = file => paths.some(p => file === p || file.startsWith(p + '/'))

    const structural = [
      `${src}/sections/Hero.jsx`,
      `${src}/sections/Hero/index.jsx`,
      `${src}/sections/Hero/meta.js`,
      `${src}/layouts/docs/index.jsx`,
      `${src}/meta.js`,
      `${src}/main.js`,
      `${src}/foundation.js`,
      `${src}/styles.css`,
      `${src}/index.css`
    ]

    for (const file of structural) {
      expect(shouldRegenerateForFile(file, src)).not.toBeNull()
      expect(covered(file)).toBe(true)
    }
  })

  it('excludes the directories that make a package root unwatchable', () => {
    const paths = getStructuralWatchPaths(src)
    for (const dir of ['node_modules', 'dist', '.git']) {
      expect(paths.some(p => p.includes(dir))).toBe(false)
    }
  })

  it('covers extra section paths declared by the foundation', () => {
    const paths = getStructuralWatchPaths(src, {
      sectionPaths: ['sections', 'sections/marketing', 'widgets']
    })

    expect(paths).toContain(join(src, 'sections/marketing'))
    expect(paths).toContain(join(src, 'widgets'))

    // Extra paths use strict discovery — a section there is only registered
    // once it has a meta.js, and that is what has to reach the predicate.
    expect(shouldRegenerateForFile(`${src}/widgets/Chart/meta.js`, src)).toBe('meta.js changed')
    expect(paths.some(p => `${src}/widgets/Chart/meta.js`.startsWith(p + '/'))).toBe(true)
  })

  it('is layout-agnostic — paths are relative to the resolved source root', () => {
    // The documented workspace layouts: single, segregated, co-located,
    // extension. Folder depth and naming differ; the watch surface must not.
    for (const root of ['/w/src', '/w/foundations/blog', '/w/marketing/src', '/w/extensions/effects']) {
      const paths = getStructuralWatchPaths(root)

      // Never the source root itself — that is the package root under the flat layout.
      expect(paths).not.toContain(root)

      // Every path sits under this root, and the set is identical across layouts.
      expect(paths.every(p => p.startsWith(root + '/'))).toBe(true)
      expect(paths.map(p => p.slice(root.length + 1))).toEqual(
        getStructuralWatchPaths('/w/src').map(p => p.slice('/w/src'.length + 1))
      )
    }
  })
})
