/**
 * Regression guard for the shipped standard schemas.
 *
 * `validateAndNormalizeSchema` is the build-time gate for the data-schema
 * authoring format: it throws on an invalid schema definition. Every standard
 * schema exported by `@uniweb/schemas` must pass that gate, so a foundation can
 * reference any of them (`@uniweb/person`, `@uniweb/event`, …) and still get a
 * clean build. This test fires if a future edit to a standard schema — or to
 * the normalizer itself — makes one of them invalid.
 *
 * It iterates the live registry rather than a hard-coded list, so a newly added
 * standard schema is covered automatically (and the explicit non-empty check
 * stops the suite from passing vacuously if the registry ever resolves empty).
 */
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { schemas, getSchemaNames } from '@uniweb/schemas'

describe('standard schemas stay valid against the data-schema normalizer', () => {
  const names = getSchemaNames()

  it('exports at least one standard schema', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  it.each(names)("'%s' normalizes without throwing", (name) => {
    const schema = schemas[name]
    const out = validateAndNormalizeSchema(schema, `@std/${name}`)

    // The normalizer returns a plain object carrying exactly one of the two
    // structural forms it guarantees: fields-form (a flat field map) XOR
    // sections-form (named single/multi/binder sections).
    expect(out && typeof out === 'object' && !Array.isArray(out)).toBe(true)
    const hasFields = out.fields !== undefined
    const hasSections = out.sections !== undefined
    expect(hasFields).not.toBe(hasSections)

    // Schema identity carries through verbatim.
    if (schema.name !== undefined) expect(out.name).toBe(schema.name)
  })
})
