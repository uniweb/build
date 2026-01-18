import { computeHash, normalizeText } from '../../src/i18n/hash.js'

describe('normalizeText', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello')
    expect(normalizeText('\n\thello\n\t')).toBe('hello')
  })

  it('collapses multiple spaces to single space', () => {
    expect(normalizeText('hello   world')).toBe('hello world')
    expect(normalizeText('hello\n\nworld')).toBe('hello world')
    expect(normalizeText('hello\t\tworld')).toBe('hello world')
  })

  it('handles empty string', () => {
    expect(normalizeText('')).toBe('')
  })

  it('handles non-string input', () => {
    expect(normalizeText(null)).toBe('')
    expect(normalizeText(undefined)).toBe('')
    expect(normalizeText(123)).toBe('')
  })
})

describe('computeHash', () => {
  it('produces 8-character hex string', () => {
    const hash = computeHash('Hello World')
    expect(hash).toHaveLength(8)
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('produces same hash for same input', () => {
    const hash1 = computeHash('Hello World')
    const hash2 = computeHash('Hello World')
    expect(hash1).toBe(hash2)
  })

  it('produces different hash for different input', () => {
    const hash1 = computeHash('Hello World')
    const hash2 = computeHash('Hello Universe')
    expect(hash1).not.toBe(hash2)
  })

  it('normalizes whitespace before hashing', () => {
    const hash1 = computeHash('Hello World')
    const hash2 = computeHash('  Hello   World  ')
    const hash3 = computeHash('Hello\n\tWorld')
    expect(hash1).toBe(hash2)
    expect(hash1).toBe(hash3)
  })

  it('handles empty string', () => {
    const hash = computeHash('')
    expect(hash).toHaveLength(8)
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is case sensitive', () => {
    const hash1 = computeHash('Hello')
    const hash2 = computeHash('hello')
    expect(hash1).not.toBe(hash2)
  })

  it('handles unicode characters', () => {
    const hash = computeHash('Bienvenido al mundo')
    expect(hash).toHaveLength(8)
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
  })
})
