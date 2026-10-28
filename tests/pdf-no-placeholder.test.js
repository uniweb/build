/**
 * A page's PDF gets no placeholder card (2026-10-28).
 *
 * The build drew a "PDF · N pages" card for each PDF a page named, wrote it to
 * dist/assets/ and kept it in a map that nothing read, so no page showed it. A
 * document's preview is the one its author names (`{preview=…}`). A file record's
 * preview is another thing, and keeps its card (`file-records.js`).
 */

import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processAdvancedAssets } from '../src/site/advanced-processors.js'

describe('a PDF a page names', () => {
  let dir

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'uniweb-pdf-card-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('gets no card: only videos are processed, and nothing is written for it', async () => {
    await writeFile(join(dir, 'report.pdf'), '%PDF-1.4\n')
    const outputDir = join(dir, 'dist')
    await mkdir(outputDir, { recursive: true })
    const manifest = { './report.pdf': { original: './report.pdf', resolved: join(dir, 'report.pdf'), isPdf: true } }

    const result = await processAdvancedAssets(manifest, { outputDir })
    expect(result).toEqual({ posterMapping: {}, results: { videos: { processed: 0, skipped: 0, explicit: 0 } } })
    expect(await readdir(outputDir)).toEqual([])
  })
})
