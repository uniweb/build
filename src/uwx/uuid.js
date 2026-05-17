// UUIDv7 minting for .uwx entity / item ids.
//
// Uniweb exchange ids are UUIDv7, not v4: v7 is time-ordered, which keeps
// index locality good for the time-sorted id columns an importer maintains.
// Node's crypto.randomUUID() is v4, so we mint v7 by hand.
//
// Layout per RFC 9562 §5.7:
//   bits  0..47   unix_ts_ms (big-endian, ms since epoch)
//   bits 48..51   version (0b0111)
//   bits 52..63   rand_a
//   bits 64..65   variant (0b10)
//   bits 66..127  rand_b

import { randomBytes } from 'node:crypto'

export function mintUuidV7() {
  const bytes = randomBytes(16)
  const ts = BigInt(Date.now())

  // 48-bit millisecond timestamp, big-endian, into bytes[0..5].
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)

  // version 7 in the high nibble of byte 6; variant 0b10 in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  )
}
