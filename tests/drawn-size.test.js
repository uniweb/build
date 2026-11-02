/**
 * The size a browser draws an image at, read from its first bytes.
 *
 * A size with the wrong proportions moves a page as much as no size does, so the reader answers only
 * where every browser draws the same one. These files are what an image library writes, and what a
 * phone or an old tool leaves in them. Each rule was measured in Chromium, WebKit and Firefox.
 */

import sharp from 'sharp'
import { crc32 } from 'node:zlib'
import { drawnSize, RAN_OUT } from '../src/site/drawn-size.js'

const WIDE = { width: 64, height: 32 }
const TALL = { width: 32, height: 64 }

const solid = ({ width, height } = WIDE, channels = 3) =>
  sharp({ create: { width, height, channels, background: channels === 4 ? '#c0000080' : '#c00' } })

/** Frames of one size, as an animation in a library's hands. */
const frames = (count = 3, { width, height } = WIDE) =>
  sharp(Buffer.alloc(width * height * count * 3, 0x80), {
    raw: { width, height: height * count, channels: 3, pageHeight: height },
  })

const le16 = (n) => [n & 255, n >> 8]
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]

/** A little-endian TIFF block: the picture's directory, then its thumbnail's. */
function exif({ own = [], thumbnail = [] }) {
  const nextAt = 8 + 2 + own.length * 12 + 4
  const entry = ([tag, type, value]) => Buffer.from([...le16(tag), ...le16(type), ...le32(1), ...le32(value)])
  const directory = (entries, next) =>
    Buffer.concat([Buffer.from(le16(entries.length)), ...entries.map(entry), Buffer.from(le32(next))])
  return Buffer.concat([
    Buffer.from([0x49, 0x49, 42, 0, ...le32(8)]),
    directory(own, thumbnail.length ? nextAt : 0),
    ...(thumbnail.length ? [directory(thumbnail, 0)] : []),
  ])
}

const ORIENTATION_6 = [0x0112, 3, 6]

const app1 = (...parts) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body])
}
const exifApp1 = (block) => app1(Buffer.from('Exif\0\0', 'latin1'), block)
/** A JPEG with these segments right after its signature. */
const jpegWith = async (...segments) => {
  const file = await solid().jpeg().toBuffer()
  return Buffer.concat([file.subarray(0, 2), ...segments, file.subarray(2)])
}

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
/** A PNG with these chunks between its header and its data, and these after its data. */
const pngWith = async ({ before = [], after = [] }) => {
  const file = await solid().png().toBuffer()
  const header = file.subarray(0, 33)
  const end = file.length - 12
  return Buffer.concat([header, ...before, file.subarray(33, end), ...after, file.subarray(end)])
}

describe('a file as an image library writes it', () => {
  it.each([
    ['a JPEG', () => solid().jpeg().toBuffer()],
    ['a progressive JPEG', () => solid().jpeg({ progressive: true }).toBuffer()],
    ['a PNG', () => solid().png().toBuffer()],
    ['a GIF', () => solid().gif().toBuffer()],
    ['an animated GIF', () => frames().gif().toBuffer()],
    ['a lossy WebP', () => solid().webp().toBuffer()],
    ['a lossless WebP', () => solid().webp({ lossless: true }).toBuffer()],
    ['a WebP with transparency', () => solid(WIDE, 4).webp().toBuffer()],
    ['an animated WebP', () => frames().webp().toBuffer()],
    ['an AVIF', () => solid().avif().toBuffer()],
  ])('%s', async (_name, write) => {
    expect(drawnSize(await write())).toEqual(WIDE)
  })

  it('a phone\'s portrait photo is the size it draws at', async () => {
    expect(drawnSize(await solid().withMetadata({ orientation: 6 }).jpeg().toBuffer())).toEqual(TALL)
  })

  it('reads the start of a file as it reads the whole', async () => {
    const file = await sharp(Buffer.alloc(900 * 600 * 3).map((_, i) => (i * 31) % 251), {
      raw: { width: 900, height: 600, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer()
    expect(file.length).toBeGreaterThan(70000)
    expect(drawnSize(file.subarray(0, 65536))).toEqual({ width: 900, height: 600 })
  })
})

describe('what a JPEG\'s EXIF does', () => {
  it('turns it', async () => {
    expect(drawnSize(await jpegWith(exifApp1(exif({ own: [ORIENTATION_6] }))))).toEqual(TALL)
  })

  it('leaves it where an orientation doesn\'t swap its sides', async () => {
    expect(drawnSize(await jpegWith(exifApp1(exif({ own: [[0x0112, 3, 3]] }))))).toEqual(WIDE)
  })

  it('gives none where only WebKit reads the orientation, on its thumbnail', async () => {
    const block = exif({ own: [[0x0128, 3, 2]], thumbnail: [ORIENTATION_6] })
    expect(drawnSize(await jpegWith(exifApp1(block)))).toBeNull()
  })

  it('reads the picture\'s own orientation over its thumbnail\'s', async () => {
    const block = exif({ own: [[0x0112, 3, 1]], thumbnail: [ORIENTATION_6] })
    expect(drawnSize(await jpegWith(exifApp1(block)))).toEqual(WIDE)
  })

  it('gives none where Firefox misses it, behind another APP1', async () => {
    const xmp = app1(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>', 'latin1'))
    expect(drawnSize(await jpegWith(xmp, exifApp1(exif({ own: [ORIENTATION_6] }))))).toBeNull()
    expect(drawnSize(await jpegWith(exifApp1(exif({ own: [ORIENTATION_6] })), xmp))).toEqual(TALL)
  })

  // A pointer past the end of its block is a tool's leftover, and browsers read the rest.
  it('reads an orientation beside a pointer that goes nowhere', async () => {
    const block = exif({ own: [ORIENTATION_6, [0x8769, 4, 9999]] })
    expect(drawnSize(await jpegWith(exifApp1(block)))).toEqual(TALL)
  })

  describe('its resolution', () => {
    /** A resolution, and the pixels the EXIF says the picture has, behind their pointer. */
    const stating = (pixels, { dpi = 144, unit = 2, turned = false } = {}) => {
      const own = [...(turned ? [ORIENTATION_6] : []), [0x011a, 5, 0], [0x011b, 5, 8], [0x0128, 3, unit], [0x8769, 4, 0]]
      const inner = [[0xa002, 4, pixels.width], [0xa003, 4, pixels.height]]
      const innerAt = 8 + 2 + own.length * 12 + 4
      const rationalsAt = innerAt + 2 + inner.length * 12 + 4
      const entry = ([tag, type, value]) => {
        const held = tag === 0x8769 ? innerAt : type === 5 ? rationalsAt + value : value
        return Buffer.from([...le16(tag), ...le16(type), ...le32(1), ...le32(held)])
      }
      return Buffer.concat([
        Buffer.from([0x49, 0x49, 42, 0, ...le32(8), ...le16(own.length)]),
        ...own.map(entry),
        Buffer.from([...le32(0), ...le16(inner.length)]),
        ...inner.map(entry),
        Buffer.from([...le32(0), ...le32(dpi), ...le32(1), ...le32(dpi), ...le32(1)]),
      ])
    }

    it('corrects the size where the pixels it states are the file\'s at that resolution', async () => {
      expect(drawnSize(await jpegWith(exifApp1(stating({ width: 32, height: 16 }))))).toEqual({ width: 32, height: 16 })
    })

    it('corrects it, then turns it', async () => {
      expect(drawnSize(await jpegWith(exifApp1(stating({ width: 32, height: 16 }, { turned: true }))))).toEqual({
        width: 16,
        height: 32,
      })
    })

    it('leaves a file that was resized and kept a phone\'s tags', async () => {
      expect(drawnSize(await jpegWith(exifApp1(stating({ width: 4032, height: 3024 }))))).toEqual(WIDE)
    })

    it('leaves a file stating its own pixels at 144 dpi', async () => {
      expect(drawnSize(await jpegWith(exifApp1(stating(WIDE))))).toEqual(WIDE)
    })

    it('leaves a resolution in centimetres', async () => {
      expect(drawnSize(await jpegWith(exifApp1(stating({ width: 32, height: 16 }, { unit: 3 }))))).toEqual(WIDE)
    })

    it('gives none in a PNG, which only Firefox corrects', async () => {
      const block = stating({ width: 32, height: 16 })
      expect(drawnSize(await pngWith({ before: [chunk('eXIf', block)] }))).toBeNull()
    })
  })
})

describe('what a PNG\'s EXIF does', () => {
  const block = exif({ own: [ORIENTATION_6] })

  it('turns it, ahead of its data', async () => {
    expect(drawnSize(await pngWith({ before: [chunk('eXIf', block)] }))).toEqual(TALL)
  })

  it('leaves it, after its data', async () => {
    expect(drawnSize(await pngWith({ after: [chunk('eXIf', block)] }))).toEqual(WIDE)
  })
})

describe('files browsers disagree on', () => {
  it('a WebP whose EXIF turns it, which only WebKit does', async () => {
    const file = await solid().withMetadata({ orientation: 6 }).webp().toBuffer()
    expect(drawnSize(file)).toBeNull()
  })

  it('a GIF whose first frame doesn\'t fill its screen', async () => {
    const file = await solid().gif().toBuffer()
    file.writeUInt16LE(128, 6)
    expect(drawnSize(file)).toBeNull()
  })
})

describe('a file with no size to give', () => {
  it.each([
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"/>', 'latin1')],
    ['a PDF', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')],
    ['a BMP', Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(60)])],
    ['nothing a picture starts with', Buffer.from('hello, world', 'latin1')],
  ])('%s', (_name, file) => {
    expect(drawnSize(file)).toBeNull()
  })
})

describe('whatever it is handed', () => {
  const files = () =>
    Promise.all([
      solid().jpeg().toBuffer(),
      solid().withMetadata({ orientation: 6 }).jpeg().toBuffer(),
      solid().png().toBuffer(),
      solid().gif().toBuffer(),
      frames(2).gif().toBuffer(),
      solid().webp().toBuffer(),
      solid().webp({ lossless: true }).toBuffer(),
      solid().withMetadata({ orientation: 6 }).webp().toBuffer(),
      solid().avif().toBuffer(),
      jpegWith(exifApp1(exif({ own: [ORIENTATION_6], thumbnail: [ORIENTATION_6] }))),
      pngWith({ before: [chunk('eXIf', exif({ own: [ORIENTATION_6] }))] }),
    ])

  const isAnswer = (answer) =>
    answer === null || answer === RAN_OUT || (answer.width > 0 && answer.height > 0 && Object.keys(answer).length === 2)

  it('answers on every start of a file, and says when it ran out', async () => {
    for (const file of await files()) {
      for (let length = 0; length < Math.min(file.length, 1500); length++) {
        expect(isAnswer(drawnSize(file.subarray(0, length))), `${length} bytes of ${file.length}`).toBe(true)
      }
      expect(drawnSize(file.subarray(0, 1))).toBe(RAN_OUT)
    }
  })

  it('answers on a file with any byte of its start changed', async () => {
    for (const file of await files()) {
      for (let at = 0; at < Math.min(file.length, 400); at++) {
        for (const value of [0x00, 0xff, file[at] ^ 0x55]) {
          const changed = Buffer.from(file)
          changed[at] = value
          expect(isAnswer(drawnSize(changed)), `byte ${at} as ${value}`).toBe(true)
        }
      }
    }
  })

  it('takes a plain typed array', async () => {
    const file = await solid().png().toBuffer()
    expect(drawnSize(new Uint8Array(file))).toEqual(WIDE)
  })
})
