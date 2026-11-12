/**
 * An image the build copies keeps its place on the page, and looks as it did.
 *
 * With no size, an image has no height until its file arrives, and everything under it jumps. The
 * copy is the one place that knows the size of the file a static site serves, so it stamps it on the
 * image's node in the built content, the way it stamps a document's name and size: never in what an
 * author stored, and never over a size an author wrote.
 *
 * The conversion it reads from has to leave the picture as it was, so a phone's portrait photo and
 * an animated GIF are here too.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { parseContent } from '@uniweb/semantic-parser'
import { processAssets, rewriteContentPaths } from '../src/site/asset-processor.js'

const solid = (width, height) => sharp({ create: { width, height, channels: 3, background: '#c00' } })

describe('an image the build copies', () => {
  let dir, outputDir

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'uniweb-image-size-'))
    outputDir = join(dir, 'dist')
    await mkdir(outputDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Write a file and copy it as a build does. */
  const copied = async (name, bytes, options = {}) => {
    const resolved = join(dir, name)
    await writeFile(resolved, bytes)
    const ref = `./${name}`
    return { ref, ...(await processAssets({ [ref]: { original: ref, resolved, isImage: true } }, { outputDir, ...options })) }
  }

  const built = (ref, attrs, pathMapping, files) =>
    rewriteContentPaths({ type: 'doc', content: [{ type: 'image', attrs: { src: ref, ...attrs } }] }, pathMapping, files)

  const drawn = (doc) => parseContent(doc).images[0]

  it("carries the file's own size to a component", async () => {
    const { ref, pathMapping, files } = await copied('hero.png', await solid(780, 1170).png().toBuffer())
    expect(files[ref]).toMatchObject({ width: 780, height: 1170 })
    expect(drawn(built(ref, { alt: 'Hero' }, pathMapping, files))).toMatchObject({ width: 780, height: 1170 })
  })

  it('CONTROL: with no facts from the copy, an image has no size', async () => {
    const { ref, pathMapping } = await copied('hero.png', await solid(780, 1170).png().toBuffer())
    const image = drawn(built(ref, { alt: 'Hero' }, pathMapping, null))
    expect(image).not.toHaveProperty('width')
    expect(image).not.toHaveProperty('height')
  })

  it('reads a file it passes through as well as one it converts', async () => {
    const { ref, pathMapping, files } = await copied('hero.webp', await solid(64, 32).webp().toBuffer())
    expect(drawn(built(ref, {}, pathMapping, files))).toMatchObject({ width: 64, height: 32 })
  })

  // Only WebKit turns a WebP by its EXIF. The rule turns one whose EXIF says to (`prepareImage`), so
  // every browser draws it the same, and at the size it was turned to.
  it('turns a WebP its EXIF says to turn, and gives the size every browser draws it at', async () => {
    const bytes = await solid(64, 32).withMetadata({ orientation: 6 }).webp().toBuffer()
    const { ref, pathMapping, files } = await copied('turned.webp', bytes)
    expect(files[ref]).toMatchObject({ width: 32, height: 64 })
    expect(drawn(built(ref, {}, pathMapping, files))).toMatchObject({ width: 32, height: 64 })
  })

  // A build that turns conversion off (the site plugin's `assets.convertToWebp: false`) copies the WebP
  // as it is, so a size would have the wrong proportions in every browser but WebKit.
  it('gives no size to a file browsers would draw differently', async () => {
    const bytes = await solid(64, 32).withMetadata({ orientation: 6 }).webp().toBuffer()
    const { ref, pathMapping, files } = await copied('turned.webp', bytes, { convertToWebp: false })
    expect(files[ref]).not.toHaveProperty('width')
    const image = drawn(built(ref, {}, pathMapping, files))
    expect(image).not.toHaveProperty('width')
    expect(image).not.toHaveProperty('height')
  })

  it('leaves a size the author wrote, whole or in part', async () => {
    const { ref, pathMapping, files } = await copied('hero.png', await solid(780, 1170).png().toBuffer())
    expect(drawn(built(ref, { width: 300, height: 200 }, pathMapping, files))).toMatchObject({ width: 300, height: 200 })
    const widthOnly = drawn(built(ref, { width: 300 }, pathMapping, files))
    expect(widthOnly.width).toBe(300)
    expect(widthOnly).not.toHaveProperty('height')
  })

  it('leaves an icon alone: its own `size` sizes it', async () => {
    const { ref, pathMapping, files } = await copied('mark.png', await solid(512, 512).png().toBuffer())
    const node = built(ref, { role: 'icon' }, pathMapping, files).content[0]
    expect(node.attrs).not.toHaveProperty('width')
    expect(node.attrs).not.toHaveProperty('height')
  })

  it('leaves a vector alone: a browser sizes one by its own rules', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><rect width="24" height="12"/></svg>'
    const { ref, pathMapping, files } = await copied('logo.svg', svg)
    expect(files[ref]).not.toHaveProperty('width')
    expect(built(ref, {}, pathMapping, files).content[0].attrs).not.toHaveProperty('width')
  })

  it('copies a file it cannot read the size of, with no size', async () => {
    const { ref, pathMapping, files } = await copied('favicon.ico', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))
    expect(files[ref]).toMatchObject({ mime: expect.any(String) })
    expect(files[ref]).not.toHaveProperty('width')
    expect(pathMapping[ref]).toMatch(/^\/assets\/favicon-[0-9a-f]{8}\.ico$/)
  })

  it('leaves a file that is not an image with no size', async () => {
    const resolved = join(dir, 'report.pdf')
    await writeFile(resolved, '%PDF-1.4\n')
    const { files } = await processAssets({ './report.pdf': { original: './report.pdf', resolved, isPdf: true } }, { outputDir })
    expect(files['./report.pdf']).toEqual({ name: 'report.pdf', size: 9, mime: 'application/pdf' })
  })

  it("draws a phone's portrait photo upright, and gives the size it draws at", async () => {
    // A phone stores a portrait photo on its side, and a tag says how to turn it.
    const photo = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const { ref, pathMapping, files } = await copied('photo.jpg', photo)
    expect(files[ref]).toMatchObject({ width: 20, height: 40 })
    const made = await sharp(await readFile(join(outputDir, pathMapping[ref]))).metadata()
    expect(made).toMatchObject({ width: 20, height: 40 })
    expect(made.orientation).toBeUndefined()
  })

  it('keeps every frame of an animated GIF, and gives the size of one', async () => {
    // Two flat frames: a WebP of it would not save a tenth, so the GIF is kept as it is.
    const [width, height, pages] = [8, 6, 2]
    const raw = Buffer.alloc(width * height * pages * 3, 200)
    raw.fill(40, width * height * 3) // the second frame differs from the first
    const gif = await sharp(raw, { raw: { width, height: height * pages, channels: 3, pageHeight: height } }).gif().toBuffer()

    const { ref, pathMapping, files } = await copied('loop.gif', gif)
    expect(pathMapping[ref]).toMatch(/\.gif$/)
    expect(files[ref]).toMatchObject({ width, height })
    const made = await sharp(await readFile(join(outputDir, pathMapping[ref])), { animated: true }).metadata()
    expect(made.pages).toBe(pages)
  })

  it('a GIF the WebP shrinks becomes an animated WebP with every frame', async () => {
    const [width, height, pages] = [48, 36, 3]
    const raw = Buffer.alloc(width * height * pages * 3)
    let x = 7
    for (let i = 0; i < raw.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      raw[i] = (x >> 16) & 0xff
    }
    const gif = await sharp(raw, { raw: { width, height: height * pages, channels: 3, pageHeight: height } }).gif().toBuffer()

    const { ref, pathMapping, files } = await copied('noise.gif', gif)
    expect(pathMapping[ref]).toMatch(/\.webp$/)
    expect(files[ref]).toMatchObject({ width, height })
    const made = await sharp(await readFile(join(outputDir, pathMapping[ref])), { animated: true }).metadata()
    expect(made.pages).toBe(pages)
  })
})
