/**
 * `prepareImage`: the one rule for a picture a site keeps — what a push uploads and what a static
 * build copies. Every input is made here with sharp, so each case says what it is.
 */
import { describe, it, expect } from 'vitest'
import { crc32 } from 'node:zlib'
import sharp from 'sharp'
import { prepareImage, withoutPrivateMetadata, isPreparableImage, IMAGE_RULE } from '../src/prepare-image.js'

/** A photograph's worth of detail: noise, so lossy codecs have work to do. */
function noise(width, height, channels = 3, seed = 7) {
  const data = Buffer.alloc(width * height * channels)
  let x = seed
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    data[i] = (x >> 16) & 0xff
  }
  return sharp(data, { raw: { width, height, channels } })
}

/** A phone's photo: orientation 6, a Display P3 profile, the camera and where it was taken. */
const phonePhoto = (options = {}) =>
  noise(64, 48)
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: 'PhoneMaker', Model: 'Phone 15' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '45/1 25/1 0/1' },
    })
    .withIccProfile('p3')
    .jpeg({ quality: 95, ...options })
    .toBuffer()

const hasMarker = (jpeg, marker) => {
  for (let i = 2; i + 1 < jpeg.length; i++) if (jpeg[i] === 0xff && jpeg[i + 1] === marker) return true
  return false
}

/** A PNG with one more chunk, put before IEND, its CRC computed. */
function withChunk(png, type, data) {
  const iend = png.length - 12
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([png.subarray(0, iend), length, body, crc, png.subarray(iend)])
}

describe('prepareImage — what it makes', () => {
  it('⭐ a phone photo becomes a WebP, turned upright, its colour in sRGB, its camera and location gone', async () => {
    const input = await phonePhoto()
    const before = await sharp(input).metadata()
    expect(before.orientation).toBe(6)
    expect(input.includes(Buffer.from('PhoneMaker'))).toBe(true)

    const out = await prepareImage(input, 'jpg')
    expect(out.converted).toBe(true)
    expect(out.ext).toBe('webp')
    const after = await sharp(out.bytes).metadata()
    expect(after.format).toBe('webp')
    expect([after.width, after.height]).toEqual([48, 64]) // turned
    expect(after.orientation ?? 1).toBe(1)
    expect(after.exif).toBeUndefined()
    // Converted into sRGB with no profile embedded, as a host converting it would: equal to an
    // explicit transform to sRGB, and not the P3 values read as sRGB.
    expect(after.icc).toBeUndefined()
    const mean = async (b) => (await sharp(b).stats()).channels.slice(0, 3).map((c) => Math.round(c.mean))
    const toSrgb = await sharp(input).autoOrient().withIccProfile('srgb').webp({ quality: IMAGE_RULE.quality }).toBuffer()
    expect(await mean(out.bytes)).toEqual(await mean(toSrgb))
    expect(out.bytes.includes(Buffer.from('PhoneMaker'))).toBe(false)
  })

  it('⭐ a file the WebP would not shrink by a tenth is kept, without its camera and location, its pixels untouched', async () => {
    // Already squeezed hard: WebP at the rule's quality comes out larger.
    const input = await noise(64, 48)
      .withIccProfile('p3')
      .withExif({ IFD0: { Make: 'PhoneMaker' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '45/1 25/1 0/1' } })
      .jpeg({ quality: 20 })
      .toBuffer()
    const out = await prepareImage(input, 'jpeg')
    expect(out.converted).toBe(false)
    expect(out.ext).toBe('jpeg')
    expect(out.bytes.includes(Buffer.from('PhoneMaker'))).toBe(false)
    expect(hasMarker(out.bytes, 0xe1)).toBe(false) // no EXIF, no XMP
    const after = await sharp(out.bytes).metadata()
    expect(after.icc).toBeDefined()
    // The image data itself is byte for byte the author's.
    const raw = (b) => sharp(b).raw().toBuffer()
    expect((await raw(out.bytes)).equals(await raw(input))).toBe(true)
  })

  it('a file that would be kept but needs turning is converted, so nothing stands on a tag', async () => {
    const input = await noise(64, 48)
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 20 })
      .toBuffer()
    const out = await prepareImage(input, 'jpg')
    expect(out.converted).toBe(true)
    const after = await sharp(out.bytes).metadata()
    expect([after.width, after.height]).toEqual([48, 64])
  })

  it('alpha is kept', async () => {
    const input = await noise(64, 64, 4).png().toBuffer()
    const out = await prepareImage(input, 'png')
    expect(out.converted).toBe(true)
    expect((await sharp(out.bytes).metadata()).hasAlpha).toBe(true)
  })

  it('a GIF keeps its frames', async () => {
    const frames = await Promise.all([1, 2, 3].map((s) => noise(32, 32, 3, s).raw().toBuffer()))
    const input = await sharp(Buffer.concat(frames), { raw: { width: 32, height: 96, channels: 3, pageHeight: 32 } })
      .gif({ loop: 0, delay: [100, 100, 100] })
      .toBuffer()
    expect((await sharp(input, { animated: true }).metadata()).pages).toBe(3)
    const out = await prepareImage(input, 'gif')
    expect(out.converted).toBe(true)
    expect((await sharp(out.bytes, { animated: true }).metadata()).pages).toBe(3)
  })

  it('an animated PNG is kept, since its frames would not survive, without its private chunks', async () => {
    const png = await noise(16, 16).png().toBuffer()
    // An acTL chunk before IDAT marks it animated. Put it right after IHDR.
    const ihdrEnd = 8 + 12 + png.readUInt32BE(8)
    const actl = withChunk(Buffer.concat([png.subarray(0, ihdrEnd), png.subarray(png.length - 12)]), 'acTL', Buffer.alloc(8))
    const animated = Buffer.concat([actl.subarray(0, actl.length - 12), png.subarray(ihdrEnd)])
    const tagged = withChunk(animated, 'tEXt', Buffer.from('Author\0Somebody', 'latin1'))
    const out = await prepareImage(tagged, 'png')
    expect(out.converted).toBe(false)
    expect(out.bytes.includes(Buffer.from('acTL'))).toBe(true)
    expect(out.bytes.includes(Buffer.from('Somebody'))).toBe(false)
  })

  it('a TIFF is converted whatever the sizes, since most browsers cannot draw one', async () => {
    const input = await noise(32, 32).tiff({ compression: 'jpeg', quality: 10 }).toBuffer()
    const out = await prepareImage(input, 'tif')
    expect(out.converted).toBe(true)
    expect(out.ext).toBe('webp')
  })

  it('a BMP, which nothing here decodes, is kept as it is and reported', async () => {
    const bmp = Buffer.from(
      '424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000ff000000',
      'hex',
    )
    const out = await prepareImage(bmp, 'bmp')
    expect(out).toMatchObject({ converted: false, ext: 'bmp', unreadable: true })
    expect(out.bytes.equals(bmp)).toBe(true)
  })

  it('SVG, ICO, WebP and AVIF are left as they are', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    for (const ext of ['svg', 'ico', 'webp', 'avif']) {
      expect(isPreparableImage(ext)).toBe(false)
      const out = await prepareImage(svg, ext)
      expect(out).toEqual({ bytes: svg, ext, converted: false })
    }
  })

  it('⭐ the same bytes give the same result, so a prepared file has one identity', async () => {
    const input = await phonePhoto()
    const [a, b] = await Promise.all([prepareImage(input, 'jpg'), prepareImage(input, 'jpg')])
    expect(a.bytes.equals(b.bytes)).toBe(true)
  })

  it('the WebP replaces the file at the keep ratio, and not above it', async () => {
    expect(IMAGE_RULE).toEqual({ quality: 85, keepRatio: 0.9 })
    const input = await noise(64, 48).jpeg({ quality: 95 }).toBuffer()
    const webp = await sharp(input).webp({ quality: IMAGE_RULE.quality }).toBuffer()
    expect(webp.length).toBeLessThanOrEqual(input.length * IMAGE_RULE.keepRatio)
    expect((await prepareImage(input, 'jpg')).converted).toBe(true)
  })
})

describe('withoutPrivateMetadata — a kept file loses its private data and nothing else', () => {
  it('a progressive JPEG: every scan kept, EXIF and comments gone, still the same picture', async () => {
    const input = await noise(64, 48)
      .withExif({ IFD0: { Make: 'PhoneMaker' } })
      .jpeg({ quality: 90, progressive: true })
      .toBuffer()
    const out = withoutPrivateMetadata(input, 'jpg')
    expect(out.length).toBeLessThan(input.length)
    expect(out.includes(Buffer.from('PhoneMaker'))).toBe(false)
    const raw = (b) => sharp(b).raw().toBuffer()
    expect((await raw(out)).equals(await raw(input))).toBe(true)
  })

  it('a JPEG loses what trails its image, such as a second picture a phone appends', async () => {
    const main = await noise(32, 32).jpeg().toBuffer()
    const trailing = await noise(16, 16).withExif({ IFD0: { Make: 'PhoneMaker' } }).jpeg().toBuffer()
    const out = withoutPrivateMetadata(Buffer.concat([main, trailing]), 'jpeg')
    expect(out.equals(withoutPrivateMetadata(main, 'jpeg'))).toBe(true)
    expect(out.includes(Buffer.from('PhoneMaker'))).toBe(false)
  })

  it('a PNG loses eXIf, tEXt, zTXt, iTXt and tIME, and keeps its other chunks', async () => {
    let png = await noise(16, 16).withIccProfile('p3').png().toBuffer()
    png = withChunk(png, 'tEXt', Buffer.from('Author\0Somebody', 'latin1'))
    png = withChunk(png, 'tIME', Buffer.alloc(7))
    const out = withoutPrivateMetadata(png, 'png')
    expect(out.includes(Buffer.from('Somebody'))).toBe(false)
    expect(out.includes(Buffer.from('tIME'))).toBe(false)
    expect(out.includes(Buffer.from('iCCP'))).toBe(true)
    expect((await sharp(out).raw().toBuffer()).equals(await sharp(png).raw().toBuffer())).toBe(true)
  })

  it('a file that does not parse as its format is returned as it is', () => {
    const junk = Buffer.from('not an image')
    expect(withoutPrivateMetadata(junk, 'jpg')).toBe(junk)
    expect(withoutPrivateMetadata(junk, 'png')).toBe(junk)
    expect(withoutPrivateMetadata(junk, 'gif')).toBe(junk)
  })
})
