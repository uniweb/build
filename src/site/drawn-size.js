/**
 * The size a browser draws an image at, read from the first bytes of its file.
 *
 * `width` and `height` on an `<img>` hold its place on the page while its file loads, and a size with
 * the wrong proportions moves the page as much as no size does. So this answers with a size only where
 * every browser draws the same one, which isn't every file. Measured on `naturalWidth` and
 * `naturalHeight` in Chromium 156, WebKit 27.2 and Firefox 157, 2026-11-02:
 *
 *   JPEG, PNG   an EXIF orientation of 5 to 8 swaps the sides, in a PNG only ahead of its data
 *   JPEG        EXIF's resolution corrects the size where the pixels it states are the file's at that
 *               resolution: 16x8 at 144 dpi stating 8x4 draws at 8x4. In a PNG only Firefox does: none
 *   JPEG        an orientation in any but the first APP1 segment: Firefox doesn't read it: none
 *   JPEG, PNG   an orientation only on the thumbnail: only WebKit reads it: none
 *   WebP        an EXIF orientation of 5 to 8: only WebKit turns it: none. Else its canvas
 *   GIF         its screen, where the first frame fills it. Else they differ: none
 *   AVIF        its primary item's size, an `irot` swapping the sides. A `clap`: they differ: none
 *
 * It reads headers and never decodes, so it needs only the start of a file, and its answers can't
 * change with an image library's version or the machine it runs on.
 *
 * @module @uniweb/build/site
 */

/** The bytes ended before the answer. A caller holding only the start of a file reads further. */
export const RAN_OUT = 'ran-out'

const OUT = Symbol('out of bytes')

const need = (b, end) => {
  if (end > b.length) throw OUT
}
const u8 = (b, at) => (need(b, at + 1), b[at])
const be16 = (b, at) => (need(b, at + 2), b.readUInt16BE(at))
const be32 = (b, at) => (need(b, at + 4), b.readUInt32BE(at))
const le16 = (b, at) => (need(b, at + 2), b.readUInt16LE(at))
const le24 = (b, at) => (need(b, at + 3), b.readUIntLE(at, 3))
const le32 = (b, at) => (need(b, at + 4), b.readUInt32LE(at))
const text = (b, at, length) => (need(b, at + length), b.latin1Slice(at, at + length))

const sized = (width, height) => (width > 0 && height > 0 ? { width, height } : null)

const NO_EXIF = { turns: false, thumbnailTurns: false }

/** What `read` answers, or undefined where it runs out of bytes. */
function attempt(read) {
  try {
    return read()
  } catch (thrown) {
    if (thrown === OUT) return undefined
    throw thrown
  }
}

/**
 * What a block of EXIF says about its picture. The block is held whole by now, so running out of it
 * means that part is malformed, and a browser reads a malformed part as saying nothing.
 *
 * @returns {{ turns: boolean, thumbnailTurns: boolean, density?: Object }} `turns`: its orientation is a
 *   quarter turn, which swaps the picture's sides. `thumbnailTurns`: the picture has no orientation of
 *   its own and its thumbnail's is one. `density`: the resolution and the pixels it states, if any.
 */
function readExif(block) {
  const facts = attempt(() => {
    const order = text(block, 0, 2)
    if (order !== 'II' && order !== 'MM') return null
    const u16 = order === 'II' ? le16 : be16
    const u32 = order === 'II' ? le32 : be32
    if (u16(block, 2) !== 42) return null

    const entries = (ifd) => {
      const found = new Map()
      const count = u16(block, ifd)
      for (let i = 0, at = ifd + 2; i < count && at + 12 <= block.length; i++, at += 12) found.set(u16(block, at), at)
      return found
    }
    const value = (entry) => {
      if (entry === undefined) return undefined
      const type = u16(block, entry + 2)
      if (type === 3) return u16(block, entry + 8)
      if (type === 4) return u32(block, entry + 8)
      if (type !== 5) return undefined
      const at = u32(block, entry + 8)
      return u32(block, at) / u32(block, at + 4)
    }
    const isTurn = (orientation) => orientation >= 5 && orientation <= 8

    const first = u32(block, 4)
    const own = entries(first)
    const orientation = value(own.get(0x0112))
    return {
      turns: isTurn(orientation),
      thumbnailTurns:
        orientation === undefined &&
        isTurn(
          attempt(() => {
            const next = u32(block, first + 2 + u16(block, first) * 12)
            return next ? value(entries(next).get(0x0112)) : undefined
          }),
        ),
      density: attempt(() => {
        const pixels = entries(value(own.get(0x8769)))
        return {
          x: value(own.get(0x011a)),
          y: value(own.get(0x011b)),
          unit: value(own.get(0x0128)),
          width: value(pixels.get(0xa002)),
          height: value(pixels.get(0xa003)),
        }
      }),
    }
  })
  return facts ?? NO_EXIF
}

const swapped = (size) => sized(size.height, size.width)
const same = (one, other) => one.width === other.width && one.height === other.height

/**
 * The size EXIF's resolution corrects a picture to, which is the HTML standard's rule: in inches, and
 * only where the pixels it states are the file's at that resolution. So a file that was resized and
 * kept a phone's tags isn't corrected, and neither is one at 144 dpi stating its own pixels.
 */
function corrected(size, { density }) {
  if (!density || density.unit !== 2) return size
  const { x, y, width, height } = density
  if (!(x > 0 && y > 0 && width > 0 && height > 0)) return size
  return Math.round((size.width * 72) / x) === width && Math.round((size.height * 72) / y) === height
    ? { width, height }
    : size
}

/** A JPEG's size, from the headers before its data starts: every browser corrects it, then turns it. */
function jpeg(b) {
  let size = null
  let exif = null
  let first = true
  let app1 = 0
  let at = 2
  for (;;) {
    if (u8(b, at) !== 0xff) return null
    let marker = u8(b, at + 1)
    while (marker === 0xff) marker = u8(b, ++at + 1)
    at += 2
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = be16(b, at)
    if (length < 2) return null
    // Each start-of-frame marker, which are C0 to CF but for C4, C8 and CC.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      size = sized(be16(b, at + 5), be16(b, at + 3))
    } else if (marker === 0xe1) {
      need(b, at + length)
      if (!exif && length >= 8 && text(b, at + 2, 6) === 'Exif\0\0') {
        exif = readExif(b.subarray(at + 8, at + length))
        first = app1 === 0
      }
      app1++
    }
    at += length
  }
  if (!size || !exif) return size
  // Only WebKit reads a thumbnail's orientation.
  if (exif.thumbnailTurns) return null
  const fixed = corrected(size, exif)
  const drawn = exif.turns ? swapped(fixed) : fixed
  // Firefox reads only the first of these segments, and the others read any of them.
  return first || same(drawn, size) ? drawn : null
}

/** A PNG's size, turned by EXIF ahead of its data and not after it. Only Firefox corrects one. */
function png(b) {
  if (be32(b, 8) !== 13 || text(b, 12, 4) !== 'IHDR') return null
  const size = sized(be32(b, 16), be32(b, 20))
  if (!size) return null
  let exif = null
  let at = 33
  for (;;) {
    const length = be32(b, at)
    const type = text(b, at + 4, 4)
    if (type === 'IDAT' || type === 'IEND') break
    if (type === 'eXIf' && !exif) {
      need(b, at + 8 + length)
      exif = readExif(b.subarray(at + 8, at + 8 + length))
    }
    at += 12 + length
  }
  if (!exif) return size
  if (exif.thumbnailTurns || !same(corrected(size, exif), size)) return null
  return exif.turns ? swapped(size) : size
}

/** A GIF's screen, where its first frame fills it. Browsers disagree on one that doesn't. */
function gif(b) {
  const size = sized(le16(b, 6), le16(b, 8))
  if (!size) return null
  const flags = u8(b, 10)
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0)
  for (;;) {
    const block = u8(b, at)
    if (block === 0x2c) {
      const fills =
        le16(b, at + 1) === 0 && le16(b, at + 3) === 0 && le16(b, at + 5) === size.width && le16(b, at + 7) === size.height
      return fills ? size : null
    }
    if (block !== 0x21) return null
    at += 2
    for (let length = u8(b, at); length; length = u8(b, at)) at += length + 1
    at += 1
  }
}

/** A WebP's canvas. Only WebKit turns one by its EXIF, so one that says to has no size. */
function webp(b) {
  if (text(b, 8, 4) !== 'WEBP') return null
  const first = text(b, 12, 4)
  if (first === 'VP8 ') {
    if (be32(b, 23) >>> 8 !== 0x9d012a) return null
    return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff)
  }
  if (first === 'VP8L') {
    if (u8(b, 20) !== 0x2f) return null
    const bits = le32(b, 21)
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (first !== 'VP8X') return null
  const size = sized(le24(b, 24) + 1, le24(b, 27) + 1)
  if (!(u8(b, 20) & 0x08)) return size
  const end = 8 + le32(b, 4)
  for (let at = 30; at < end; ) {
    const type = text(b, at, 4)
    const length = le32(b, at + 4)
    if (type === 'EXIF') {
      need(b, at + 8 + length)
      const start = text(b, at + 8, 6) === 'Exif\0\0' ? at + 14 : at + 8
      return readExif(b.subarray(start, at + 8 + length)).turns ? null : size
    }
    at += 8 + length + (length & 1)
  }
  return size
}

/** The boxes in `[at, end)` of a file in the format an AVIF uses, as `[type, start, end]`. */
function* boxes(b, at, end) {
  while (at < end) {
    let size = be32(b, at)
    const type = text(b, at + 4, 4)
    let start = at + 8
    if (size === 1) {
      size = be32(b, at + 8) * 2 ** 32 + be32(b, at + 12)
      start = at + 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < start - at) throw OUT
    yield [type, start, at + size]
    at += size
  }
}

/**
 * An AVIF's size, which is its primary item's, turned by its `irot`. Browsers disagree on a crop.
 */
function avif(b) {
  const ftyp = be32(b, 0)
  need(b, ftyp)
  const brands = [text(b, 8, 4)]
  for (let at = 16; at + 4 <= ftyp; at += 4) brands.push(text(b, at, 4))
  if (!brands.includes('avif')) return null

  for (const [type, start, end] of boxes(b, ftyp, Infinity)) {
    if (type !== 'meta') continue
    need(b, end)
    let primary = null
    let properties = null
    let links = null
    for (const [inner, from, to] of boxes(b, start + 4, end)) {
      if (inner === 'pitm') primary = u8(b, from) === 0 ? be16(b, from + 4) : be32(b, from + 4)
      if (inner !== 'iprp') continue
      for (const [box, boxFrom, boxTo] of boxes(b, from, to)) {
        if (box === 'ipco') properties = [...boxes(b, boxFrom, boxTo)]
        if (box === 'ipma') links = [boxFrom, boxTo]
      }
    }
    if (primary === null || !properties || !links) return null

    const [ipma] = links
    const version = u8(b, ipma)
    const wide = u8(b, ipma + 3) & 1
    let at = ipma + 8
    for (let i = be32(b, ipma + 4); i > 0; i--) {
      const item = version < 1 ? be16(b, at) : be32(b, at)
      at += version < 1 ? 2 : 4
      const count = u8(b, at++)
      const own = []
      for (let n = 0; n < count; n++) {
        own.push(wide ? be16(b, at) & 0x7fff : u8(b, at) & 0x7f)
        at += wide ? 2 : 1
      }
      if (item !== primary) continue
      const held = own.map((index) => properties[index - 1]).filter(Boolean)
      if (held.some(([box]) => box === 'clap')) return null
      const spatial = held.find(([box]) => box === 'ispe')
      if (!spatial) return null
      const size = sized(be32(b, spatial[1] + 4), be32(b, spatial[1] + 8))
      const rotation = held.find(([box]) => box === 'irot')
      return size && rotation && u8(b, rotation[1]) & 1 ? swapped(size) : size
    }
    return null
  }
  return null
}

const READERS = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), png],
  [Buffer.from([0xff, 0xd8]), jpeg],
  [Buffer.from('GIF87a', 'latin1'), gif],
  [Buffer.from('GIF89a', 'latin1'), gif],
  [Buffer.from('RIFF', 'latin1'), webp],
]

function read(b) {
  for (const [signature, reader] of READERS) {
    const head = b.subarray(0, signature.length)
    if (head.equals(signature)) return reader(b)
    if (head.length < signature.length && head.equals(signature.subarray(0, head.length))) throw OUT
  }
  return text(b, 4, 4) === 'ftyp' ? avif(b) : null
}

/**
 * @param {Uint8Array} bytes - a file, or the start of one
 * @returns {{ width: number, height: number } | null | 'ran-out'} the size every browser draws it at;
 *   null when it has none to give, however much more of it there is (a vector, or a file browsers
 *   draw differently); or `RAN_OUT`
 */
export function drawnSize(bytes) {
  const answer = attempt(() => read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)))
  return answer === undefined ? RAN_OUT : answer
}
