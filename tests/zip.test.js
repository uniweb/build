import { describe, it, expect } from 'vitest'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { createZip, readZip } from '../src/uwx/zip.js'
import { crc32 } from '../src/uwx/crc32.js'

// Hand-frame a single-entry ZIP using Deflate (method 8) — the shape the backend's
// pull `.uwx` uses — independently of `createZip`, so the reader's inflate path is
// checked against bytes our writer did not make. Mirrors createZip's field offsets,
// with method 8 + a deflated payload.
function deflateZip(name, text) {
  const data = Buffer.from(text, 'utf8')
  const comp = deflateRawSync(data)
  const nameBuf = Buffer.from(name, 'utf8')
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8) // method 8 = Deflate
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(comp.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10) // method 8
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(comp.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42) // local header offset

  const localPart = Buffer.concat([local, nameBuf, comp])
  const centralPart = Buffer.concat([central, nameBuf])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)

  return Buffer.concat([localPart, centralPart, eocd])
}

// Walk the LOCAL headers front to back, without `readZip` — a second reading of what
// `createZip` wrote, so a writer bug the reader shares cannot pass unseen.
function localEntries(buf) {
  const out = []
  let p = 0
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8)
    const crc = buf.readUInt32LE(p + 14)
    const compSize = buf.readUInt32LE(p + 18)
    const size = buf.readUInt32LE(p + 22)
    const nameLen = buf.readUInt16LE(p + 26)
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen)
    const raw = buf.subarray(p + 30 + nameLen, p + 30 + nameLen + compSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    out.push({ name, method, crc, compSize, size, data })
    p += 30 + nameLen + compSize
  }
  return out
}

// name → { method, compSize, size } from the central directory, which is what a reader
// that trusts the central copy (ours, and most) goes by.
function centralEntries(buf) {
  const eocd = buf.length - 22
  const total = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < total; n++) {
    const nameLen = buf.readUInt16LE(p + 28)
    out.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24)
    })
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

const pageTree = () =>
  Buffer.from(
    JSON.stringify({
      pages: Array.from({ length: 40 }, (_, i) => ({
        route: `/docs/page-${i}`,
        sections: [{ content: { type: 'doc', content: [{ type: 'paragraph', text: 'Lorem ipsum. '.repeat(20) }] } }]
      }))
    }),
    'utf8'
  )

describe('uwx/zip createZip', () => {
  it('Deflates an entry Deflate makes smaller, and says so in both headers', () => {
    const data = pageTree()
    const buf = createZip([{ name: 'entities/site-content.json', data }])

    const [local] = localEntries(buf)
    expect(local.method).toBe(8)
    expect(local.size).toBe(data.length)
    expect(local.compSize).toBeLessThan(data.length / 4)
    expect(local.crc).toBe(crc32(data)) // the CRC is over the uncompressed bytes
    expect(local.data.equals(data)).toBe(true)

    expect(centralEntries(buf).get('entities/site-content.json')).toEqual({
      method: 8,
      compSize: local.compSize,
      size: data.length
    })
    expect(readZip(buf).get('entities/site-content.json').equals(data)).toBe(true)
  })

  it('Stores an entry Deflate would not shrink — a tiny one, and an empty one', () => {
    const buf = createZip([
      { name: 'a.json', data: Buffer.from('{"x":1}', 'utf8') },
      { name: 'empty.json', data: Buffer.alloc(0) }
    ])
    for (const entry of localEntries(buf)) {
      expect(entry.method).toBe(0)
      expect(entry.compSize).toBe(entry.size)
    }
    const files = readZip(buf)
    expect(files.get('a.json').toString('utf8')).toBe('{"x":1}')
    expect(files.get('empty.json').length).toBe(0)
  })

  it('writes a package of several entries the same way twice, each entry at its own offset', () => {
    const files = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ uwx: 1, entries: [{ file: 'entities/a.json' }] }), 'utf8') },
      { name: 'entities/a.json', data: pageTree() },
      { name: 'entities/b.json', data: Buffer.from('{"b":true}', 'utf8') }
    ]
    const buf = createZip(files)
    expect(createZip(files).equals(buf)).toBe(true)

    // Each entry on its own measure: this manifest is too short to shrink.
    expect(localEntries(buf).map((e) => [e.name, e.method])).toEqual([
      ['manifest.json', 0],
      ['entities/a.json', 8],
      ['entities/b.json', 0]
    ])
    const read = readZip(buf)
    for (const f of files) expect(read.get(f.name).equals(f.data)).toBe(true)
  })
})

describe('uwx/zip readZip', () => {
  it('round-trips a Stored entry (createZip → readZip)', () => {
    const buf = createZip([{ name: 'a.json', data: Buffer.from('{"x":1}', 'utf8') }])
    expect(readZip(buf).get('a.json').toString('utf8')).toBe('{"x":1}')
  })

  it('inflates a Deflate (method 8) entry — the backend pull .uwx shape', () => {
    const text = JSON.stringify({ info: { seo: { image: '/og.png' } }, pad: 'x'.repeat(800) })
    const m = readZip(deflateZip('entities/e.json', text))
    expect(m.get('entities/e.json').toString('utf8')).toBe(text)
  })
})
