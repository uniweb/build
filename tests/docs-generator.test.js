import { describe, it, expect } from 'vitest'
import { generateDocsFromSchema } from '../src/docs.js'

describe('generateDocsFromSchema', () => {
  it('documents the section types, and not the schema keys beside them', () => {
    const md = generateDocsFromSchema({
      _self: { name: 'f' },
      _layouts: { Docs: { name: 'Docs' } },
      dataSchemas: { '@/member': { name: 'member' } },
      Hero: { name: 'Hero' },
    })
    expect(md).toContain('## Hero')
    expect(md).not.toContain('## _layouts')
    expect(md).not.toContain('## dataSchemas')
  })
})
