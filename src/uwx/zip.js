// Minimal, zero-dependency ZIP writer/reader for .uwx containers.
//
// DESIGN DECISION: our WRITER (`createZip`) emits Stored only (compression
// method 0), no Deflate. A .uwx container is a ZIP; compression is an
// optimization, not part of the contract, and every standard ZIP reader
// handles Stored entries. Staying Stored-only on write removes a class of
// cross-tool byte asymmetry. The READER (`readZip`) additionally inflates
// Deflate (method 8) entries — the backend's pull `.uwx` Deflates larger
// entities, and the framework must read what the backend produces.
//
// No Zip64: per-record JSON files are far below 4 GiB and entry counts far
// below 65535. The format is otherwise the classic APPNOTE layout, all
// multi-byte fields little-endian.
//
// Determinism: mod time/date are fixed to 0. The .uwx content key is
// `manifest.package_sha256` (computed over the manifest, NOT the ZIP bytes),
// so ZIP framing never participates in dedupe; fixing the timestamp just
// makes byte output reproducible for a given input.

import { crc32 } from './crc32.js'
import { inflateRawSync } from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const VERSION = 20 // 2.0 — the minimum that supports Stored with a CRC

/**
 * @param {{name: string, data: Buffer}[]} files
 * @returns {Buffer}
 */
export function createZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const data = file.data
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(0, 6) // general purpose bit flag
    local.writeUInt16LE(0, 8) // compression method: 0 = Stored
    local.writeUInt16LE(0, 10) // mod time (fixed)
    local.writeUInt16LE(0, 12) // mod date (fixed)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size == uncompressed
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    localParts.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(VERSION, 4) // version made by
    central.writeUInt16LE(VERSION, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(files.length, 8) // entries on this disk
  eocd.writeUInt16LE(files.length, 10) // total entries
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16) // central dir offset
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, centralDir, eocd])
}

/**
 * Reader for `.uwx` containers. Handles Stored (method 0 — what our writer emits)
 * and Deflate (method 8 — what the backend's pull `.uwx` uses); any other method
 * throws. Not otherwise a general-purpose unzip (no Zip64, no encryption).
 *
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} name -> uncompressed data
 */
export function readZip(buf) {
  const out = new Map()
  // Locate EOCD by scanning backward (no archive comment, so it's the
  // last 22 bytes, but scan to be robust).
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('uwx/zip: end-of-central-directory not found')

  const total = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error('uwx/zip: bad central directory signature')
    }
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    // Walk the local header to find the data start (its name/extra
    // lengths can differ from the central copy in general; read them).
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    // Stored (0) → verbatim; Deflate (8) → inflate the raw deflate stream.
    if (method === 0) out.set(name, raw)
    else if (method === 8) out.set(name, inflateRawSync(raw))
    else throw new Error(`uwx/zip: unsupported compression method ${method} for ${name}`)

    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
