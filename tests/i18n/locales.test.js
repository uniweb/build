/**
 * Tests for locale resolution utilities
 */

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { getAvailableLocales, resolveLocales } from '../../src/i18n/index.js'

const TEST_DIR = '/tmp/uniweb-locale-tests'

describe('getAvailableLocales', () => {
  beforeAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })
  })

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  it('should find locale json files', async () => {
    const localesDir = join(TEST_DIR, 'locales-basic')
    await mkdir(localesDir, { recursive: true })
    await writeFile(join(localesDir, 'es.json'), '{}')
    await writeFile(join(localesDir, 'fr.json'), '{}')

    const locales = await getAvailableLocales(localesDir)
    expect(locales).toEqual(['es', 'fr'])
  })

  it('should exclude manifest.json', async () => {
    const localesDir = join(TEST_DIR, 'locales-manifest')
    await mkdir(localesDir, { recursive: true })
    await writeFile(join(localesDir, 'es.json'), '{}')
    await writeFile(join(localesDir, 'manifest.json'), '{}')

    const locales = await getAvailableLocales(localesDir)
    expect(locales).toEqual(['es'])
  })

  it('should exclude _memory.json', async () => {
    const localesDir = join(TEST_DIR, 'locales-memory')
    await mkdir(localesDir, { recursive: true })
    await writeFile(join(localesDir, 'fr.json'), '{}')
    await writeFile(join(localesDir, '_memory.json'), '{}')

    const locales = await getAvailableLocales(localesDir)
    expect(locales).toEqual(['fr'])
  })

  it('should return empty array for non-existent directory', async () => {
    const locales = await getAvailableLocales('/non/existent/path')
    expect(locales).toEqual([])
  })

  it('should return empty array for empty directory', async () => {
    const localesDir = join(TEST_DIR, 'locales-empty')
    await mkdir(localesDir, { recursive: true })

    const locales = await getAvailableLocales(localesDir)
    expect(locales).toEqual([])
  })

  it('should sort locales alphabetically', async () => {
    const localesDir = join(TEST_DIR, 'locales-sort')
    await mkdir(localesDir, { recursive: true })
    await writeFile(join(localesDir, 'zh.json'), '{}')
    await writeFile(join(localesDir, 'ar.json'), '{}')
    await writeFile(join(localesDir, 'fr.json'), '{}')

    const locales = await getAvailableLocales(localesDir)
    expect(locales).toEqual(['ar', 'fr', 'zh'])
  })
})

describe('resolveLocales', () => {
  const localesDir = join(TEST_DIR, 'resolve-locales')

  beforeAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(localesDir, { recursive: true })
    await writeFile(join(localesDir, 'de.json'), '{}')
    await writeFile(join(localesDir, 'es.json'), '{}')
    await writeFile(join(localesDir, 'fr.json'), '{}')
  })

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  it('should return all available for undefined', async () => {
    const locales = await resolveLocales(undefined, localesDir)
    expect(locales).toEqual(['de', 'es', 'fr'])
  })

  it('should return all available for null', async () => {
    const locales = await resolveLocales(null, localesDir)
    expect(locales).toEqual(['de', 'es', 'fr'])
  })

  it('should return all available for empty array', async () => {
    const locales = await resolveLocales([], localesDir)
    expect(locales).toEqual(['de', 'es', 'fr'])
  })

  it('should return all available for "*" string', async () => {
    const locales = await resolveLocales('*', localesDir)
    expect(locales).toEqual(['de', 'es', 'fr'])
  })

  it('should return all available for ["*"] array', async () => {
    const locales = await resolveLocales(['*'], localesDir)
    expect(locales).toEqual(['de', 'es', 'fr'])
  })

  it('should return specific locales when array provided', async () => {
    const locales = await resolveLocales(['es', 'fr'], localesDir)
    expect(locales).toEqual(['es', 'fr'])
  })

  it('should preserve order of specific locales', async () => {
    const locales = await resolveLocales(['fr', 'de', 'es'], localesDir)
    expect(locales).toEqual(['fr', 'de', 'es'])
  })

  it('should allow locales not in directory (for pre-translation)', async () => {
    const locales = await resolveLocales(['ja', 'ko'], localesDir)
    expect(locales).toEqual(['ja', 'ko'])
  })
})
