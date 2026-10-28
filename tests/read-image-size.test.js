/**
 * `readImageSize` — an image's size and format, read from its bytes. `uniweb doctor` measures
 * the image a link to a site shows with it, so the format is the file's, never its extension's,
 * and a file sharp cannot read answers null rather than throwing or printing. `isImageOpaque`
 * likewise, for whether any pixel is transparent.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { readImageSize, isImageOpaque } from '../src/images.js'

const DIRS = []
afterEach(() => {
  while (DIRS.length) rmSync(DIRS.pop(), { recursive: true, force: true })
})

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'image-size-'))
  DIRS.push(dir)
  return dir
}

const blank = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: '#9b5a36' } })

describe('readImageSize', () => {
  it('reads the size and format from the bytes', async () => {
    const file = join(tmp(), 'card.jpg')
    await blank(1200, 630).jpeg().toFile(file)
    expect(await readImageSize(file)).toEqual({ width: 1200, height: 630, format: 'jpeg' })
  })

  it('names the format the bytes are, whatever the extension says', async () => {
    const file = join(tmp(), 'card.jpg')
    await blank(800, 600).png().toFile(file)
    expect(await readImageSize(file)).toEqual({ width: 800, height: 600, format: 'png' })
  })

  it('reads an SVG as an SVG', async () => {
    const file = join(tmp(), 'card.svg')
    writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"></svg>')
    expect(await readImageSize(file)).toMatchObject({ width: 400, height: 200, format: 'svg' })
  })

  it('answers null, quietly, for a file that is not an image, and for none', async () => {
    const file = join(tmp(), 'card.png')
    writeFileSync(file, 'not an image')
    expect(await readImageSize(file)).toBeNull()
    expect(await readImageSize(join(tmp(), 'absent.png'))).toBeNull()
  })
})

// `uniweb doctor` asks it of a site's touch icon, whose transparent pixels iOS draws black.
describe('isImageOpaque', () => {
  const png = async (background, channels) => {
    const file = join(tmp(), 'icon.png')
    await sharp({ create: { width: 180, height: 180, channels, background } }).png().toFile(file)
    return file
  }

  it('is true for an image with no alpha channel, and for one whose alpha it never uses', async () => {
    expect(await isImageOpaque(await png('#9b5a36', 3))).toBe(true)
    expect(await isImageOpaque(await png({ r: 155, g: 90, b: 54, alpha: 1 }, 4))).toBe(true)
  })

  it('is false for an image with a transparent pixel', async () => {
    expect(await isImageOpaque(await png({ r: 0, g: 0, b: 0, alpha: 0 }, 4))).toBe(false)
  })

  it('answers null, quietly, for a file that is not an image', async () => {
    const file = join(tmp(), 'icon.png')
    writeFileSync(file, 'not an image')
    expect(await isImageOpaque(file)).toBeNull()
  })
})
