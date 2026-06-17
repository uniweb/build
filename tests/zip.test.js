import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { createZip, readZip } from '../src/uwx/zip.js'
import { crc32 } from '../src/uwx/crc32.js'

// Hand-frame a single-entry ZIP using Deflate (method 8) — the shape the backend's
// pull `.uwx` uses. Our `createZip` only emits Stored (method 0), so we build a
// Deflate entry here to exercise the reader's inflate path. Mirrors createZip's
// field offsets, with method 8 + a deflated payload.
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
