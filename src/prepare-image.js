/**
 * AN IMAGE MADE READY BEFORE IT IS STORED OR SHIPPED — one rule for every picture a site keeps:
 * what `uniweb push` and `uniweb publish` upload, and what a static build copies into `dist/`. So a
 * picture is the same wherever the site is served.
 *
 * The rule:
 *
 * 1. **WebP, lossy, at one quality** (`IMAGE_RULE.quality`).
 * 2. **The keep test.** The WebP replaces the file only when it is at most `IMAGE_RULE.keepRatio` of
 *    its size. Otherwise the file stays as it is. A format some browsers can't draw (TIFF, HEIC) is
 *    converted whatever the sizes.
 * 3. **Alpha is kept**, and so is animation (a GIF's frames; an animated PNG is kept as it is, since
 *    its frames don't survive the conversion).
 * 4. **Orientation is applied**: the pixels are turned as the photo's EXIF says. A file that would be
 *    kept but needs turning is converted instead, so no picture a page draws depends on a tag to
 *    stand up.
 * 5. **Location and camera data are dropped**, from a kept file too, which loses them without being
 *    re-encoded (`withoutPrivateMetadata`). Its orientation stays, alone, since that is what turns
 *    it. **A WebP's colour is converted to sRGB, with no profile embedded**, as a host converting a
 *    picture that wasn't prepared does, so the two agree: a phone's Display P3 photo keeps its
 *    colours, managed into sRGB, and loses the wider gamut. A kept file keeps its own profile, since
 *    it isn't re-encoded and dropping the profile alone would shift its colours.
 * 6. **No size cap.** A prepared file is the only copy kept, so it keeps its pixels.
 * 7. **Which files.** JPEG, PNG, GIF, TIFF, HEIC and BMP are converted under the keep test. A WebP is
 *    kept without its location and camera data, unless its EXIF says to turn it. SVG, ICO and AVIF
 *    are left as they are, an AVIF's metadata included. A file this machine can't decode (HEIC with
 *    HEVC, and BMP, which sharp's builds don't read) is left as it is and reported `unreadable`, for
 *    its caller to say so.
 * 8. **A picture other software fetches by its address** (`keepFormat`: a favicon, a touch icon, a
 *    social image) stays in its format, since a home screen takes a PNG and a link preview a JPEG or
 *    PNG. It only loses its location and camera data.
 *
 * Deterministic: the same bytes give the same result, so a prepared file has one identity wherever
 * it is prepared with the same sharp. The quality and the keep ratio are starting points; changing
 * either changes what new uploads become, and a caller that keeps what it prepared (`uniweb push`
 * does, in `sync.json`) never prepares an unchanged file again because of it.
 *
 * @module @uniweb/build/images
 */
import { crc32 } from 'node:zlib'
import sharp from 'sharp'

/** The rule's two numbers. */
export const IMAGE_RULE = Object.freeze({
  /** WebP quality, lossy. */
  quality: 85,
  /** The WebP replaces the file only at or below this share of its size: at least 10% smaller. */
  keepRatio: 0.9,
})

/** Formats the rule prepares, by extension. */
const PREPARED = new Set(['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'heic', 'heif', 'bmp', 'webp'])

/** Formats every browser draws: kept when the WebP saves too little. */
const DRAWN_EVERYWHERE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'])

const extOf = (ext) => String(ext || '').toLowerCase().replace(/^\./, '')

/**
 * Whether the rule prepares a file with this extension.
 *
 * @param {string} ext - `png`, `.png` or `PNG`
 * @returns {boolean}
 */
export function isPreparableImage(ext) {
  return PREPARED.has(extOf(ext))
}

/**
 * Prepare an image under the rule.
 *
 * @param {Buffer} bytes - the file as its author has it
 * @param {string} ext - its extension
 * @param {{ quality?: number, keepFormat?: boolean }} [options] - `quality` overrides the rule's, for
 *   a static build whose site asks for another. `keepFormat`: a picture other software fetches by its
 *   address (rule 8), which only loses its private data.
 * @returns {Promise<{ bytes: Buffer, ext: string, converted: boolean, unreadable?: boolean }>}
 *   `converted`: `bytes` is the WebP the rule made, `ext` `webp`. Otherwise `bytes` is the file as
 *   kept, without its location and camera data, in its own format.
 */
export async function prepareImage(bytes, ext, { quality = IMAGE_RULE.quality, keepFormat = false } = {}) {
  const kind = extOf(ext)
  if (!PREPARED.has(kind)) return { bytes, ext: kind, converted: false }
  const kept = () => ({ bytes: withoutPrivateMetadata(bytes, kind), ext: kind, converted: false })
  if (keepFormat || (kind === 'png' && isAnimatedPng(bytes))) return kept()

  let meta
  let webp
  try {
    meta = await sharp(bytes, { animated: true }).metadata()
    // A WebP is drawn everywhere as it is: only one its EXIF says to turn is made again.
    if (kind === 'webp' && (meta.orientation || 1) === 1) return kept()
    // sharp's default output: colour managed into sRGB, and every profile and tag dropped.
    webp = await sharp(bytes, { animated: true })
      .autoOrient()
      .webp({ quality })
      .toBuffer()
  } catch {
    // Not decodable here (HEIC with HEVC, BMP), or too large for WebP (over 16383 px a side). A
    // file every browser draws is still kept without its private data; one that isn't, or that
    // nothing here could read, is reported, since a page may not show it.
    const drawn = DRAWN_EVERYWHERE.has(kind)
    return {
      bytes: drawn ? withoutPrivateMetadata(bytes, kind) : bytes,
      ext: kind,
      converted: false,
      ...(drawn && meta ? {} : { unreadable: true }),
    }
  }

  const turned = (meta.orientation || 1) !== 1
  const smaller = webp.length <= bytes.length * IMAGE_RULE.keepRatio
  if (!DRAWN_EVERYWHERE.has(kind) || turned || smaller) return { bytes: webp, ext: 'webp', converted: true }
  return kept()
}

/**
 * A kept file without its location and camera data, its pixels untouched. Its orientation, the one
 * tag that turns the picture, stays: the first EXIF block's, written again as a block of its own.
 *
 * - **JPEG:** drops APP1 (EXIF and XMP), APP2 other than its colour profile, APP3–APP13 (IPTC
 *   among them), APP15 and comments, and whatever trails the image (a second picture a phone appends,
 *   with its own EXIF). Keeps JFIF (APP0), the colour profile (APP2 `ICC_PROFILE`) and Adobe's
 *   colour transform (APP14).
 * - **PNG:** drops `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME`, and keeps every other chunk. An `eXIf`
 *   after the image data turns nothing in a browser, so its orientation goes with it.
 * - **WebP:** drops its `EXIF` and `XMP ` chunks and the flags that announce them, and keeps every
 *   other chunk.
 * - Anything else, or a file that doesn't parse as its format, is returned as it is.
 *
 * @param {Buffer} bytes
 * @param {string} ext
 * @returns {Buffer}
 */
export function withoutPrivateMetadata(bytes, ext) {
  const kind = extOf(ext)
  if (kind === 'jpg' || kind === 'jpeg') return stripJpeg(bytes) ?? bytes
  if (kind === 'png') return stripPng(bytes) ?? bytes
  if (kind === 'webp') return stripWebp(bytes) ?? bytes
  return bytes
}

// ── EXIF: the orientation, kept alone ────────────────────────────────────────────────────────────

const EXIF_ID = Buffer.from('Exif\0\0', 'latin1')
const isExif = (payload) => payload.subarray(0, EXIF_ID.length).equals(EXIF_ID)

/** The TIFF structure in a block of EXIF, past the `Exif\0\0` that JPEG and some writers put first. */
const tiffOf = (payload) => (isExif(payload) ? payload.subarray(EXIF_ID.length) : payload)

/** The orientation a block of EXIF's first directory states, 1 when it states none. */
function orientationIn(tiff) {
  if (tiff.length < 8) return 1
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1
  const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
  const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))
  const directory = u32(4)
  if (directory + 2 > tiff.length) return 1
  for (let k = 0, count = u16(directory); k < count; k++) {
    const entry = directory + 2 + k * 12
    if (entry + 12 > tiff.length) return 1
    if (u16(entry) !== 0x0112) continue
    // A SHORT, as the standard has it, or a LONG, as some writers put it.
    const value = u16(entry + 2) === 4 ? u32(entry + 8) : u16(entry + 8)
    return value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

/** A block of EXIF (its TIFF structure) that states an orientation and nothing else. */
function orientationOnly(orientation) {
  const tiff = Buffer.alloc(26)
  tiff.write('MM\0*', 0, 'latin1')
  tiff.writeUInt32BE(8, 4) // the first directory
  tiff.writeUInt16BE(1, 8) // one entry
  tiff.writeUInt16BE(0x0112, 10) // Orientation
  tiff.writeUInt16BE(3, 12) // a SHORT
  tiff.writeUInt32BE(1, 14) // one value
  tiff.writeUInt16BE(orientation, 18)
  return tiff // the next directory, at 22, is 0: there is none
}

// ── JPEG ─────────────────────────────────────────────────────────────────────────────────────────

const ICC_ID = Buffer.from('ICC_PROFILE\0', 'latin1')

/** Whether a JPEG segment before the image data is dropped. */
function dropsJpegSegment(marker, payload) {
  if (marker === 0xe1) return true // APP1: EXIF, XMP
  if (marker === 0xe2) return !payload.subarray(0, ICC_ID.length).equals(ICC_ID) // APP2: keep the profile only
  if (marker >= 0xe3 && marker <= 0xed) return true // APP3–APP13, IPTC (APP13) among them
  if (marker === 0xef) return true // APP15
  if (marker === 0xfe) return true // COM
  return false
}

/** The JPEG without the segments `dropsJpegSegment` names, or null when it doesn't parse. */
function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const out = [buf.subarray(0, 2)]
  let exifRead = false
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue } // fill byte
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); return Buffer.concat(out) } // EOI
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue } // no length
    if (i + 4 > buf.length) return null
    const length = buf.readUInt16BE(i + 2)
    const end = i + 2 + length
    if (end > buf.length) return null
    if (marker === 0xda) {
      // The first scan: from here to the end of the image, every later table and scan included,
      // is the picture. What follows its EOI is not.
      const eoi = endOfImage(buf, end)
      if (eoi < 0) return null
      out.push(buf.subarray(i, eoi + 2))
      return Buffer.concat(out)
    }
    const payload = buf.subarray(i + 4, end)
    if (marker === 0xe1 && !exifRead && isExif(payload)) {
      // The orientation stays, alone, where the EXIF was.
      exifRead = true
      const orientation = orientationIn(payload.subarray(EXIF_ID.length))
      if (orientation !== 1) out.push(jpegSegment(0xe1, Buffer.concat([EXIF_ID, orientationOnly(orientation)])))
    } else if (!dropsJpegSegment(marker, payload)) out.push(buf.subarray(i, end))
    i = end
  }
  return null
}

/** A JPEG segment: its marker, its length and its payload. */
function jpegSegment(marker, payload) {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

/** The offset of the EOI marker after a scan that starts at `from`, walking every later segment. */
function endOfImage(buf, from) {
  let i = from
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const next = buf[i + 1]
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) { i += next === 0xff ? 1 : 2; continue } // stuffed byte, fill, restart
    if (next === 0xd9) return i
    if (i + 4 > buf.length) return -1
    // A table or the next scan: its length says where its own data ends.
    const end = i + 2 + buf.readUInt16BE(i + 2)
    if (end > buf.length) return -1
    i = end
  }
  return -1
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PRIVATE_PNG_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])

function pngChunks(buf, visit) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let i = 8
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    const end = i + 12 + length
    if (end > buf.length) return false
    if (visit(type, i, end) === false) return true
    i = end
    if (type === 'IEND') return true
  }
  return false
}

/** The PNG without its private chunks, or null when it doesn't parse. */
function stripPng(buf) {
  const out = [buf.subarray(0, 8)]
  let exifRead = false
  let afterData = false
  const parsed = pngChunks(buf, (type, start, end) => {
    if (type === 'IDAT') afterData = true
    if (type === 'eXIf' && !exifRead && !afterData) {
      // The orientation stays, alone, where the EXIF was.
      exifRead = true
      const orientation = orientationIn(tiffOf(buf.subarray(start + 8, end - 4)))
      if (orientation !== 1) out.push(pngChunk('eXIf', orientationOnly(orientation)))
    } else if (!PRIVATE_PNG_CHUNKS.has(type)) out.push(buf.subarray(start, end))
  })
  return parsed ? Buffer.concat(out) : null
}

/** A PNG chunk: its length, its type, its data and their CRC. */
function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0)
  return Buffer.concat([head, data, crc])
}

/** Whether a PNG is animated: an `acTL` chunk before its image data. */
function isAnimatedPng(buf) {
  let animated = false
  pngChunks(buf, (type) => {
    if (type === 'acTL') animated = true
    if (type === 'acTL' || type === 'IDAT') return false
  })
  return animated
}

// ── WebP ─────────────────────────────────────────────────────────────────────────────────────────

/** The flags in a `VP8X` chunk that say an `EXIF` and an `XMP ` chunk follow. */
const WEBP_EXIF = 0x08
const WEBP_XMP = 0x04

/** The WebP without its `EXIF` and `XMP ` chunks, or null when it doesn't parse. */
function stripWebp(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const riffEnd = Math.min(8 + buf.readUInt32LE(4), buf.length)
  const out = []
  let header = null // the `VP8X` chunk, copied, since its flags change
  let exifRead = false
  let exifKept = false
  let i = 12
  while (i + 8 <= riffEnd) {
    const type = buf.toString('latin1', i, i + 4)
    const size = buf.readUInt32LE(i + 4)
    if (i + 8 + size > riffEnd) return null
    const end = Math.min(i + 8 + size + (size & 1), riffEnd)
    if (type === 'EXIF') {
      const payload = buf.subarray(i + 8, i + 8 + size)
      const orientation = exifRead ? 1 : orientationIn(tiffOf(payload))
      exifRead = true
      if (orientation !== 1 && header) {
        // The orientation stays, alone, written as the file had it: sharp puts `Exif\0\0` first.
        const tiff = orientationOnly(orientation)
        out.push(webpChunk('EXIF', isExif(payload) ? Buffer.concat([EXIF_ID, tiff]) : tiff))
        exifKept = true
      }
    } else if (type === 'VP8X' && !header) {
      header = Buffer.from(buf.subarray(i, end))
      out.push(header)
    } else if (type !== 'XMP ') out.push(buf.subarray(i, end))
    i = end
  }
  if (header && header.length > 8) header[8] &= ~(WEBP_XMP | (exifKept ? 0 : WEBP_EXIF))
  const body = Buffer.concat(out)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(body.length + 4, 4)
  riff.write('WEBP', 8, 'latin1')
  return Buffer.concat([riff, body])
}

/** A WebP chunk: its type, its size, its data and the byte that pads it to an even length. */
function webpChunk(type, data) {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)])
}
