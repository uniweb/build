/**
 * A document the build copies names its file — `name`, `mime`, `size` (2026-09-29).
 *
 * A document carries a file record's field names, and the parser reads `name` and
 * `mime` from its address. But the build copies a local file as `{name}-{hash}{ext}`,
 * so the address it leaves no longer names the file, and a file's size is known only
 * where the file is. The copy is the one place that knows all three: it stamps them
 * on the document's node in the built content — never in what an author stored.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContent } from '@uniweb/semantic-parser'
import { processAssets, rewriteContentPaths } from '../src/site/asset-processor.js'
import { mimeFor } from '../src/site/file-records.js'

const PDF = '%PDF-1.4\n% a tiny file, only its bytes are counted\n'

describe('a copied document names its file', () => {
  let dir, outputDir, manifest

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'uniweb-doc-facts-'))
    outputDir = join(dir, 'dist')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(dir, 'annual-report.pdf'), PDF)
    manifest = {
      './annual-report.pdf': { original: './annual-report.pdf', resolved: join(dir, 'annual-report.pdf'), isPdf: true },
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const docWith = (attrs) => ({ type: 'doc', content: [{ type: 'image', attrs: { alt: 'Annual report', ...attrs } }] })

  it('processAssets says what it copied: the name the author gave it, its size and type', async () => {
    const { pathMapping, files } = await processAssets(manifest, { outputDir })
    expect(pathMapping['./annual-report.pdf']).toMatch(/^\/assets\/annual-report-[0-9a-f]{8}\.pdf$/)
    expect(files['./annual-report.pdf']).toEqual({ name: 'annual-report.pdf', size: PDF.length, mime: 'application/pdf' })
  })

  it('the built node carries them, and a component receives them', async () => {
    const { pathMapping, files } = await processAssets(manifest, { outputDir })
    const built = rewriteContentPaths(docWith({ src: './annual-report.pdf', role: 'pdf' }), pathMapping, files)
    const [document] = parseContent(built).documents
    expect(document).toMatchObject({ name: 'annual-report.pdf', mime: 'application/pdf', size: PDF.length })
    expect(document.url).toMatch(/annual-report-[0-9a-f]{8}\.pdf$/)
  })

  it('CONTROL — without the copy’s facts, the name is the hashed one and there is no size', async () => {
    const { pathMapping } = await processAssets(manifest, { outputDir })
    const built = rewriteContentPaths(docWith({ src: './annual-report.pdf', role: 'pdf' }), pathMapping)
    const [document] = parseContent(built).documents
    expect(document.name).toMatch(/^annual-report-[0-9a-f]{8}\.pdf$/)
    expect(document).not.toHaveProperty('size')
  })

  it('only a document is stamped, and a value written on the node stays', async () => {
    const { pathMapping, files } = await processAssets(manifest, { outputDir })
    const image = rewriteContentPaths(docWith({ src: './annual-report.pdf' }), pathMapping, files)
    expect(image.content[0].attrs).not.toHaveProperty('size')

    const named = rewriteContentPaths(docWith({ src: './annual-report.pdf', role: 'pdf', name: 'Report 2026.pdf' }), pathMapping, files)
    expect(named.content[0].attrs).toMatchObject({ name: 'Report 2026.pdf', size: PDF.length })
  })

  it('a file record’s type comes from the same table', () => {
    expect(mimeFor('brochure.pdf')).toBe('application/pdf')
    expect(mimeFor('data.csv')).toBe('text/csv')
    expect(mimeFor('unknown.xyz')).toBe('application/octet-stream')
  })
})
